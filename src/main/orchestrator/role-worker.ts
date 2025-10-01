import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Buffer } from 'node:buffer';
import type { TaskStatus, WorkerOutcomeDocument, WorkerRole, WorkerStatus } from '@shared/orchestrator';
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
  private readonly reasoningDepth: string;

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
    this.reasoningDepth = this.resolveReasoningDepth(options.role);
    const now = new Date().toISOString();
    this.status = {
      id: this.id,
      role: this.role,
      state: 'waiting',
      description: 'Waiting for tasks',
      updatedAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
      model: this.model,
      reasoningDepth: this.reasoningDepth
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
      const persisted = await this.persistArtifacts(claim.entry.record.id, result);
      const outcome = this.buildWorkerOutcome(result.outcome, persisted.outcomeDocumentPath, result.summary);
      const statusOverride = this.determineStatusOverride(result);
      const updates: {
        summary: string;
        artifacts: string[];
        workerOutcome: WorkerOutcomeDocument;
        status?: TaskStatus;
      } = {
        summary: outcome.summary || result.summary,
        artifacts: persisted.artifactPaths,
        workerOutcome: outcome
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

  private async persistArtifacts(
    taskId: string,
    result: ExecutionResult
  ): Promise<{ artifactPaths: string[]; outcomeDocumentPath?: string }> {
    const artifactPaths: string[] = [];
    const runRoot = path.resolve(this.context.runRoot);
    const seen = new Set<string>();

    const pushArtifact = (resolved: string) => {
      const normalized = path.relative(this.context.options.worktreePath, resolved).replace(/\\/g, '/');
      if (!seen.has(normalized)) {
        artifactPaths.push(normalized);
        seen.add(normalized);
      }
      return normalized;
    };

    if (result.artifacts && result.artifacts.length > 0) {
      for (const artifact of result.artifacts) {
        const resolved = path.resolve(runRoot, artifact.path);
        if (resolved !== runRoot && !resolved.startsWith(`${runRoot}${path.sep}`)) {
          throw new Error(`Artifact path escapes run root: ${artifact.path}`);
        }
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, artifact.contents, 'utf8');
        pushArtifact(resolved);
      }
    }

    let outcomeDocumentPath: string | undefined;
    if (result.outcome) {
      const relative = path.join('artifacts', `${taskId}.outcome.json`);
      const resolved = path.resolve(runRoot, relative);
      if (resolved !== runRoot && !resolved.startsWith(`${runRoot}${path.sep}`)) {
        throw new Error(`Outcome document path escapes run root: ${relative}`);
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, this.serializeOutcome(result.outcome), 'utf8');
      outcomeDocumentPath = pushArtifact(resolved);
    }

    return { artifactPaths, outcomeDocumentPath };
  }

  private appendLog(chunk: string): void {
    if (!chunk) {
      return;
    }
    const next = (this.logTail + chunk).slice(-LOG_TAIL_LIMIT);
    this.logTail = next;
    this.publishStatus({ logTail: next });
  }

  private buildWorkerOutcome(
    outcome: WorkerOutcomeDocument,
    documentPath?: string,
    fallbackSummary?: string
  ): WorkerOutcomeDocument {
    const summaryCandidate = outcome.summary?.trim() || fallbackSummary?.trim();
    const summary = summaryCandidate && summaryCandidate.length > 0 ? summaryCandidate : 'Task outcome recorded.';
    const normalized: WorkerOutcomeDocument = {
      status: outcome.status,
      summary
    };
    if (outcome.details && outcome.details.trim()) {
      normalized.details = outcome.details.trim();
    }
    const effectivePath = documentPath ?? outcome.documentPath;
    if (effectivePath) {
      normalized.documentPath = effectivePath;
    }
    return normalized;
  }

  private publishStatus(partial: Partial<WorkerStatus>): void {
    const now = new Date().toISOString();
    this.status = {
      ...this.status,
      ...partial,
      updatedAt: now,
      lastHeartbeatAt: partial.lastHeartbeatAt ?? now,
      model: this.model,
      reasoningDepth: this.reasoningDepth
    };
    this.bus.publish({
      kind: 'workers-updated',
      worktreeId: this.context.worktreeId,
      workers: [{ ...this.status }]
    });
  }

  private resolveReasoningDepth(role: WorkerRole): string {
    const env = process.env;
    const roleKey = role.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const candidates = [
      env[`CODEX_REASONING_DEPTH_${roleKey}`],
      env[`CODEX_REASONING_EFFORT_${roleKey}`],
      env.CODEX_REASONING_DEPTH,
      env.CODEX_REASONING_EFFORT
    ];
    for (const candidate of candidates) {
      if (candidate && candidate.trim()) {
        return candidate.trim();
      }
    }
    return 'low';
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
    const status = result.outcome?.status;
    if (!status) {
      return undefined;
    }
    if (status === 'blocked') {
      return 'blocked';
    }
    if (status === 'changes_requested') {
      return 'changes_requested';
    }
    if (status === 'ok' && this.role === 'reviewer') {
      return 'approved';
    }
    return undefined;
  }

  private serializeOutcome(outcome: WorkerOutcomeDocument): string {
    const payload: Record<string, unknown> = {
      status: this.formatOutcomeStatus(outcome.status),
      summary: outcome.summary
    };
    if (outcome.details && outcome.details.trim()) {
      payload.details = outcome.details.trim();
    }
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  private formatOutcomeStatus(status: WorkerOutcomeDocument['status']): string {
    switch (status) {
      case 'ok':
        return 'OK';
      case 'blocked':
        return 'BLOCKED';
      case 'changes_requested':
      default:
        return 'CHANGES_REQUESTED';
    }
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
