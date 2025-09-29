import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  OrchestratorEvent,
  OrchestratorBriefingInput,
  OrchestratorFollowUpInput,
  OrchestratorSnapshot,
  OrchestratorRunSummary,
  OrchestratorCommentInput,
  WorkerRole
} from '@shared/orchestrator';
import type {
  OrchestratorWorkerMessage,
  OrchestratorWorkerRequest,
  OrchestratorWorkerResponse,
  WorkerContextPayload
} from '@shared/orchestrator-ipc';
import type { WorkerSpawnConfig } from '@shared/orchestrator-config';

type RequestPayload<T extends OrchestratorWorkerRequest['type']> = Omit<
  Extract<OrchestratorWorkerRequest, { type: T }>,
  'id'
>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class WorkerOrchestratorBridge {
  private worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly emitter = new EventEmitter({ captureRejections: false });
  private disposed = false;

  constructor(private readonly resolveWorktreePath: (worktreeId: string) => string | null) {
    this.worker = this.spawnWorker();
  }

  on(listener: (event: OrchestratorEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  async getSnapshot(worktreeId: string): Promise<OrchestratorSnapshot | null> {
    return (await this.sendRequest('get-snapshot', { type: 'get-snapshot', worktreeId })) as
      | OrchestratorSnapshot
      | null;
  }

  async startRun(
    worktreeId: string,
    worktreePath: string,
    input: OrchestratorBriefingInput
  ): Promise<OrchestratorRunSummary> {
    const resolvedPath = this.resolveWorktreePath(worktreeId) ?? worktreePath;
    return (await this.sendRequest('start-run', {
      type: 'start-run',
      worktreeId,
      worktreePath: resolvedPath,
      input
    })) as OrchestratorRunSummary;
  }

  async submitFollowUp(worktreeId: string, input: OrchestratorFollowUpInput): Promise<OrchestratorRunSummary> {
    return (await this.sendRequest('follow-up', {
      type: 'follow-up',
      worktreeId,
      input
    })) as OrchestratorRunSummary;
  }

  async approveTask(worktreeId: string, taskId: string, approver: string): Promise<void> {
    await this.sendRequest('approve-task', {
      type: 'approve-task',
      worktreeId,
      taskId,
      approver
    });
  }

  async addComment(worktreeId: string, input: OrchestratorCommentInput): Promise<void> {
    await this.sendRequest('comment-task', { type: 'comment-task', worktreeId, input });
  }

  handleWorktreeRemoved(worktreeId: string): void {
    void this.sendRequest('worktree-removed', { type: 'worktree-removed', worktreeId }).catch((error) => {
      console.warn('[orchestrator] failed to notify worker about removal', { worktreeId, error });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.sendRequest('dispose', { type: 'dispose' }).catch(() => {});
    await this.worker.terminate();
    this.pending.forEach(({ reject }) => reject(new Error('Orchestrator bridge disposed')));
    this.pending.clear();
  }

  private spawnWorker(): Worker {
    const entry = path.join(__dirname, 'worker-entry.js');
    const worker = new Worker(entry);
    worker.on('message', (message: OrchestratorWorkerMessage) => {
      this.handleWorkerMessage(message);
    });
    worker.on('error', (error) => {
      console.error('[orchestrator] worker error', error);
      this.rejectAll(error);
      if (!this.disposed) {
        this.worker = this.spawnWorker();
      }
    });
    worker.on('exit', (code) => {
      if (this.disposed) {
        return;
      }
      const error = new Error(`Orchestrator worker exited with code ${code}`);
      this.rejectAll(error);
      this.worker = this.spawnWorker();
    });
    return worker;
  }

  private handleWorkerMessage(message: OrchestratorWorkerMessage): void {
    if ((message as { type?: unknown }).type === 'event') {
      const eventMessage = message as { event: OrchestratorEvent };
      this.emitter.emit('event', eventMessage.event);
      return;
    }
    if (!('id' in message)) {
      return;
    }
    const response = message as OrchestratorWorkerResponse;
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (!response.ok) {
      pending.reject(new Error(response.error));
      return;
    }
    const result = 'result' in response ? response.result ?? null : null;
    pending.resolve(result);
  }

  private async sendRequest<T extends OrchestratorWorkerRequest['type']>(
    _type: T,
    request: RequestPayload<T>
  ): Promise<unknown> {
    if (this.disposed) {
      throw new Error('Orchestrator bridge disposed');
    }
    const id = randomUUID();
    const message = { ...(request as object), id } as Extract<OrchestratorWorkerRequest, { type: T }>;
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private rejectAll(error: unknown): void {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }

  async startWorkers(worktreeId: string, context: WorkerContextPayload, configs: WorkerSpawnConfig[]): Promise<void> {
    await this.sendRequest('start-workers', { type: 'start-workers', worktreeId, configs, context });
  }

  async stopWorkers(worktreeId: string, roles: WorkerRole[]): Promise<void> {
    await this.sendRequest('stop-workers', { type: 'stop-workers', worktreeId, roles });
  }

  async stopRun(worktreeId: string): Promise<void> {
    await this.sendRequest('stop-run', { type: 'stop-run', worktreeId });
  }
}
