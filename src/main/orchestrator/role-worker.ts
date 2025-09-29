import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Buffer } from 'node:buffer';
import type { TaskStatus, WorkerRole, WorkerStatus } from '@shared/orchestrator';
import { OrchestratorEventBus } from './event-bus';
import { TaskClaimStore, type ClaimedTask } from './task-claim-store';
import type { CodexExecutor, ExecutionResult } from './codex-executor';
import type { LoadTaskOptions } from './task-store';

const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 2000;
const LOG_TAIL_LIMIT = 4000;

export interface WorktreeRuntimeContext {
  worktreeId: string;
  runId: string;
  runRoot: string;
  options: LoadTaskOptions;
}

interface RoleWorkerOptions {
  id: string;
  index: number;
  role: WorkerRole;
  bus: OrchestratorEventBus;
  claimStore: TaskClaimStore;
  executor: CodexExecutor;
  context: WorktreeRuntimeContext;
  model?: string;
}

export class RoleWorker extends EventEmitter {
  private readonly id: string;
  private readonly role: WorkerRole;
  private readonly bus: OrchestratorEventBus;
  private readonly claimStore: TaskClaimStore;
  private readonly executor: CodexExecutor;
  private context: WorktreeRuntimeContext;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private logTail = '';
  private readonly model?: string;
  private readonly index: number;

  private status: WorkerStatus;

  constructor(options: RoleWorkerOptions) {
    super();
    this.id = options.id;
    this.index = options.index;
    this.role = options.role;
    this.bus = options.bus;
    this.claimStore = options.claimStore;
    this.executor = options.executor;
    this.context = options.context;
    this.model = options.model;
    const now = new Date().toISOString();
    this.status = {
      id: this.id,
      role: this.role,
      state: 'waiting',
      description: 'Waiting for tasks',
      updatedAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
      model: this.model
    };
  }

  updateContext(context: WorktreeRuntimeContext): void {
    this.context = context;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleHeartbeat();
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.controller) {
      this.controller.abort();
    }
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.publishStatus({ state: 'stopped', description: 'Stopped' });
  }

  getStatus(): WorkerStatus {
    return { ...this.status };
  }

  getRole(): WorkerRole {
    return this.role;
  }

  getModel(): string | undefined {
    return this.model;
  }

  getIndex(): number {
    return this.index;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const claim = await this.claimNextTask();
      if (!claim) {
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      await this.processClaim(claim);
    }
  }

  private async claimNextTask(): Promise<ClaimedTask | null> {
    try {
      const claim = await this.claimStore.claimNext({
        ...this.context.options,
        role: this.role
      });
      if (claim) {
        this.publishStatus({ state: 'working', description: `Working on ${claim.entry.record.title}` });
      }
      return claim;
    } catch (error) {
      console.warn('[orchestrator] failed to claim task', {
        role: this.role,
        message: (error as Error).message
      });
      this.publishStatus({ state: 'error', description: (error as Error).message });
      return null;
    }
  }

  private async processClaim(claim: ClaimedTask): Promise<void> {
    this.controller = new AbortController();
    const { signal } = this.controller;
    const onLog = (chunk: string, source: 'stdout' | 'stderr') => {
      const normalized = this.normalizeLogChunk(chunk);
      if (!normalized) {
        return;
      }
      this.appendLog(normalized);
      this.bus.publish({
        kind: 'worker-log',
        worktreeId: this.context.worktreeId,
        workerId: this.id,
        role: this.role,
        chunk: normalized,
        source,
        timestamp: new Date().toISOString()
      });
    };

    try {
      const result = await this.executor.execute({
        worktreePath: this.context.options.worktreePath,
        runId: this.context.runId,
        task: claim.entry.record,
        role: this.role,
        onLog,
        signal,
        model: this.model
      });
      await this.handleSuccess(claim, result);
    } catch (error) {
      if (signal.aborted && !this.running) {
        // Worker stopped intentionally; release the task without marking failure.
        await this.claimStore.release(claim);
        return;
      }
      await this.handleFailure(claim, error as Error);
    } finally {
      this.controller = null;
      if (this.running) {
        this.publishStatus({ state: 'waiting', description: 'Waiting for tasks' });
      }
    }
  }

  private async handleSuccess(claim: ClaimedTask, result: ExecutionResult): Promise<void> {
    try {
      const artifacts = await this.persistArtifacts(result);
      const statusOverride = this.determineStatusOverride(result);
      const updates: { summary: string; artifacts: string[]; status?: TaskStatus } = {
        summary: result.summary,
        artifacts
      };
      if (statusOverride) {
        updates.status = statusOverride;
      }
      const updated = await this.claimStore.markDone(claim, updates);
      if (updated) {
        this.bus.publish({
          kind: 'workers-updated',
          worktreeId: this.context.worktreeId,
          workers: [{ ...this.status, description: `Completed ${updated.title}`, logTail: this.logTail }]
        });
      }
    } catch (error) {
      await this.handleFailure(claim, error as Error);
    }
  }

  private async handleFailure(claim: ClaimedTask, error: Error): Promise<void> {
    const message = `Worker ${this.role} error: ${error.message}`;
    await this.claimStore.markBlocked(claim, message);
    this.appendLog(`${message}\n`);
    this.publishStatus({ state: 'error', description: message });
  }

  private async persistArtifacts(result: ExecutionResult): Promise<string[]> {
    if (!result.artifacts || result.artifacts.length === 0) {
      return [];
    }
    const artifacts: string[] = [];
    const runRoot = path.resolve(this.context.runRoot);
    for (const artifact of result.artifacts) {
      const resolved = path.resolve(runRoot, artifact.path);
      if (resolved !== runRoot && !resolved.startsWith(`${runRoot}${path.sep}`)) {
        throw new Error(`Artifact path escapes run root: ${artifact.path}`);
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, artifact.contents, 'utf8');
      const normalized = path
        .relative(this.context.options.worktreePath, resolved)
        .replace(/\\/g, '/');
      artifacts.push(normalized);
    }
    return artifacts;
  }

  private appendLog(chunk: string): void {
    if (!chunk) {
      return;
    }
    const next = (this.logTail + chunk).slice(-LOG_TAIL_LIMIT);
    this.logTail = next;
    this.publishStatus({ logTail: next });
  }

  private publishStatus(partial: Partial<WorkerStatus>): void {
    const now = new Date().toISOString();
    this.status = {
      ...this.status,
      ...partial,
      updatedAt: now,
      lastHeartbeatAt: partial.lastHeartbeatAt ?? now,
      model: this.model
    };
    this.bus.publish({
      kind: 'workers-updated',
      worktreeId: this.context.worktreeId,
      workers: [{ ...this.status }]
    });
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    const tick = () => {
      if (!this.running) {
        return;
      }
      this.publishStatus({ lastHeartbeatAt: new Date().toISOString() });
      this.heartbeatTimer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
    };
    this.heartbeatTimer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
  }

  private determineStatusOverride(result: ExecutionResult): TaskStatus | undefined {
    if (this.role !== 'reviewer') {
      return undefined;
    }
    const text = (result.summary ?? '').toLowerCase();
    if (!text) {
      return 'approved';
    }
    const changePhrases = [
      'requesting changes',
      'changes requested',
      'request changes',
      'needs changes',
      'requires changes',
      'blocked'
    ];
    if (changePhrases.some((phrase) => text.includes(phrase))) {
      return 'changes_requested';
    }
    return 'approved';
  }

  private normalizeLogChunk(raw: string): string {
    if (!raw) {
      return '';
    }
    const lines = raw.split(/\r?\n/);
    const formatted: string[] = [];
    for (const line of lines) {
      if (!line) {
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        formatted.push('');
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        formatted.push(line);
        continue;
      }
      if (!parsed || typeof parsed !== 'object') {
        formatted.push(line);
        continue;
      }
      const envelope = parsed as { msg?: Record<string, unknown> };
      const msg = envelope.msg;
      if (!msg || typeof msg !== 'object') {
        formatted.push(line);
        continue;
      }
      const type = typeof msg.type === 'string' ? msg.type : '';
      switch (type) {
        case 'agent_reasoning': {
          const text = typeof msg.text === 'string' ? msg.text : '';
          if (text) {
            formatted.push(`🧠 ${text}`);
          }
          break;
        }
        case 'agent_message': {
          const text = typeof msg.text === 'string' ? msg.text : '';
          if (text) {
            formatted.push(text);
          }
          break;
        }
        case 'exec_command_begin': {
          let command = '';
          if (Array.isArray(msg.command)) {
            command = (msg.command as unknown[]).map(String).join(' ');
          } else if (typeof msg.command === 'string') {
            command = msg.command;
          }
          const cwd = typeof msg.cwd === 'string' && msg.cwd ? ` (cwd: ${msg.cwd})` : '';
          formatted.push(command ? `$ ${command}${cwd}` : '▶ command started');
          break;
        }
        case 'exec_command_output_delta': {
          const chunk = typeof msg.chunk === 'string' ? msg.chunk : '';
          const decoded = this.decodeMaybeBase64(chunk);
          if (decoded) {
            formatted.push(decoded);
          }
          break;
        }
        case 'exec_command_output': {
          const chunk = typeof msg.chunk === 'string' ? msg.chunk : '';
          const decoded = this.decodeMaybeBase64(chunk);
          if (decoded) {
            formatted.push(decoded);
          }
          break;
        }
        case 'exec_command_end': {
          const stdout = typeof msg.stdout === 'string' ? msg.stdout : '';
          const stderr = typeof msg.stderr === 'string' ? msg.stderr : '';
          if (stdout) {
            formatted.push(stdout);
          }
          if (stderr) {
            formatted.push(stderr);
          }
          const exitCode = (msg.exit_code ?? msg.exitCode) as number | string | undefined;
          formatted.push(`✔ command finished${exitCode !== undefined ? ` (code ${exitCode})` : ''}`);
          break;
        }
        case 'token_count': {
          break;
        }
        default: {
          if (typeof msg.text === 'string') {
            formatted.push(msg.text);
          } else if (typeof msg.chunk === 'string') {
            formatted.push(this.decodeMaybeBase64(msg.chunk as string));
          } else {
            formatted.push(line);
          }
        }
      }
    }
    const result = formatted.join('\n').trimEnd();
    return result ? `${result}\n` : '';
  }

  private decodeMaybeBase64(value: string): string {
    if (!value) {
      return '';
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }
    const base64Pattern = /^[A-Za-z0-9+/=\s]+$/;
    if (trimmed.length % 4 === 0 && base64Pattern.test(trimmed)) {
      try {
        const buffer = Buffer.from(trimmed, 'base64');
        if (buffer.length === 0) {
          return '';
        }
        const decoded = buffer.toString('utf8');
        if (!decoded.includes('\uFFFD')) {
          return decoded;
        }
      } catch (error) {
        return value;
      }
    }
    return value;
  }
}
