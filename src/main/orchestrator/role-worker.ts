import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { WorkerRole, WorkerStatus } from '@shared/orchestrator';
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
      this.appendLog(chunk);
      this.bus.publish({
        kind: 'worker-log',
        worktreeId: this.context.worktreeId,
        workerId: this.id,
        role: this.role,
        chunk,
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
      const updated = await this.claimStore.markDone(claim, {
        summary: result.summary,
        artifacts
      });
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
}
