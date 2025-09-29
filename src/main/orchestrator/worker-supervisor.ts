import path from 'node:path';
import { OrchestratorEventBus } from './event-bus';
import { TaskClaimStore } from './task-claim-store';
import type { CodexExecutor } from './codex-executor';
import { CodexCliExecutor } from './codex-executor';
import { ImplementerExecutor } from './implementer-executor';
import { TesterExecutor } from './tester-executor';
import { ReviewerExecutor } from './reviewer-executor';
import type { WorkerRole, WorkerStatus } from '@shared/orchestrator';
import { AVAILABLE_MODELS, WORKER_ROLES, type WorkerSpawnConfig } from '@shared/orchestrator-config';
import { RoleWorker, type WorktreeRuntimeContext } from './role-worker';

interface WorktreeContext extends WorktreeRuntimeContext {}

export class WorkerSupervisor {
  private readonly contexts = new Map<string, WorktreeContext>();
  private readonly workers = new Map<string, Map<string, RoleWorker>>();
  private readonly executorFactory: (role: WorkerRole, context: WorktreeRuntimeContext) => CodexExecutor;

  constructor(
    private readonly bus: OrchestratorEventBus,
    private readonly claimStore: TaskClaimStore,
    executorFactory?: (role: WorkerRole, context: WorktreeRuntimeContext) => CodexExecutor
  ) {
    this.executorFactory = executorFactory ?? ((role, context) => this.createExecutor(role, context));
  }

  registerContext(worktreeId: string, context: WorktreeContext): void {
    this.contexts.set(worktreeId, context);
    const perWorktree = this.workers.get(worktreeId);
    if (perWorktree) {
      for (const worker of perWorktree.values()) {
        worker.updateContext(context);
      }
    }
  }

  async configure(worktreeId: string, configs: WorkerSpawnConfig[]): Promise<void> {
    const context = this.contexts.get(worktreeId);
    if (!context) {
      console.warn('[orchestrator] no runtime context for worktree', { worktreeId });
      return;
    }
    let perWorktree = this.workers.get(worktreeId);
    if (!perWorktree) {
      perWorktree = new Map();
      this.workers.set(worktreeId, perWorktree);
    }

    const grouped = new Map<WorkerRole, WorkerSpawnConfig>();
    for (const config of configs) {
      grouped.set(config.role, config);
    }

    const rolesToProcess = new Set<WorkerRole>([...grouped.keys()]);
    for (const worker of perWorktree.values()) {
      rolesToProcess.add(worker.getRole());
    }

    for (const role of rolesToProcess) {
      const config = grouped.get(role);
      const desiredCount = Math.max(0, config?.count ?? 0);
      const models = (config?.modelPriority ?? []).filter(Boolean);
      const fallbackModel = models[0] ?? AVAILABLE_MODELS[0] ?? 'gpt-5-codex';

      for (let index = 1; index <= desiredCount; index += 1) {
        const workerId = `${role}-${index}`;
        const desiredModel = models[index - 1] ?? fallbackModel;
        const existing = perWorktree.get(workerId);
        if (existing) {
          existing.updateContext(context);
          if (existing.getModel() === desiredModel) {
            existing.start();
            continue;
          }
          await existing.stop();
          perWorktree.delete(workerId);
        }
        const worker = new RoleWorker({
          id: workerId,
          index,
          role,
          model: desiredModel,
          bus: this.bus,
          claimStore: this.claimStore,
          executor: this.executorFactory(role, context),
          context
        });
        perWorktree.set(workerId, worker);
        worker.start();
      }

      for (const [workerId, worker] of perWorktree.entries()) {
        if (worker.getRole() !== role) {
          continue;
        }
        if (worker.getIndex() > desiredCount) {
          await worker.stop();
          perWorktree.delete(workerId);
        }
      }
    }
  }

  async startAll(worktreeId: string): Promise<void> {
    await this.configure(
      worktreeId,
      WORKER_ROLES.map((role) => ({ role, count: 1, modelPriority: [] }))
    );
  }

  async stopAll(worktreeId: string): Promise<void> {
    await this.configure(
      worktreeId,
      WORKER_ROLES.map((role) => ({ role, count: 0, modelPriority: [] }))
    );
  }

  async stopRoles(worktreeId: string, roles: WorkerRole[]): Promise<void> {
    await this.configure(
      worktreeId,
      roles.map((role) => ({ role, count: 0, modelPriority: [] }))
    );
  }

  dispose(): void {
    for (const [, perWorktree] of this.workers.entries()) {
      for (const worker of perWorktree.values()) {
        void worker.stop();
      }
    }
    this.workers.clear();
    this.contexts.clear();
  }

  getStatuses(worktreeId: string): WorkerStatus[] {
    const perWorktree = this.workers.get(worktreeId);
    if (!perWorktree) {
      return [];
    }
    return Array.from(perWorktree.values()).map((worker) => worker.getStatus());
  }

  private createExecutor(role: WorkerRole, context: WorktreeRuntimeContext): CodexExecutor {
    if (role === 'implementer') {
      const lock = path.join(context.runRoot, 'locks', 'implementer.lock');
      return new ImplementerExecutor({ lockPath: lock });
    }
    if (role === 'tester') {
      return new TesterExecutor();
    }
    if (role === 'reviewer') {
      return new ReviewerExecutor();
    }
    return new CodexCliExecutor();
  }
}
