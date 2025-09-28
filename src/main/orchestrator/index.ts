import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  OrchestratorBriefingInput,
  OrchestratorCommentInput,
  OrchestratorEvent,
  OrchestratorFollowUpInput,
  OrchestratorRunSummary,
  OrchestratorSnapshot,
  TaskRecord,
  WorkerStatus,
  WorkerRole
} from '@shared/orchestrator';
import { OrchestratorEventBus } from './event-bus';
import { TaskStore } from './task-store';
import { OrchestratorScheduler } from './scheduler';
import { DEFAULT_COUNTS, DEFAULT_PRIORITY, WORKER_ROLES, type WorkerSpawnConfig } from '@shared/orchestrator-config';

type OrchestratorListener = Parameters<OrchestratorEventBus['subscribe']>[0];

interface RunState {
  run: OrchestratorRunSummary;
  tasks: TaskRecord[];
  worktreePath: string;
  paths: {
    runRoot: string;
    tasksRoot: string;
    conversationRoot: string;
  };
  lastEventAt?: string;
  workers: WorkerStatus[];
  implementerLockHeldBy?: string | null;
  desiredCounts: Partial<Record<WorkerRole, number>>;
  modelPriority: Partial<Record<WorkerRole, string[]>>;
}

export class OrchestratorCoordinator {
  private readonly runs = new Map<string, RunState>();

  private readonly bus: OrchestratorEventBus;

  private readonly taskStore: TaskStore;

  private readonly scheduler: OrchestratorScheduler;

  private readonly taskWatchers = new Map<string, () => Promise<void>>();

  private readonly unsubscribeBus: () => void;

  constructor(
    private readonly resolveWorktreePath: (worktreeId: string) => string | null,
    options?: {
      bus?: OrchestratorEventBus;
      taskStore?: TaskStore;
      scheduler?: OrchestratorScheduler;
    }
  ) {
    this.bus = options?.bus ?? new OrchestratorEventBus();
    this.taskStore = options?.taskStore ?? new TaskStore();
    this.scheduler = options?.scheduler ?? new OrchestratorScheduler(this.bus);
    this.unsubscribeBus = this.bus.subscribe((event) => {
      this.handleBusEvent(event);
    });
  }

  on(listener: OrchestratorListener): () => void {
    return this.bus.subscribe(listener);
  }

  async getSnapshot(worktreeId: string): Promise<OrchestratorSnapshot | null> {
    const state = this.runs.get(worktreeId);
    if (!state) {
      return null;
    }
    return this.cloneSnapshot(state);
  }

  async startRun(worktreeId: string, input: OrchestratorBriefingInput): Promise<OrchestratorRunSummary> {
    const cwd = this.resolveWorktreePath(worktreeId);
    if (!cwd) {
      throw new Error(`Unknown worktree: ${worktreeId}`);
    }
    const now = new Date().toISOString();
    const run: OrchestratorRunSummary = {
      worktreeId,
      runId: randomUUID(),
      epicId: null,
      status: 'running',
      description: input.description,
      guidance: input.guidance,
      createdAt: now,
      updatedAt: now
    };
    const runRoot = path.join(cwd, 'codex-runs', run.runId);
    const tasksRoot = path.join(runRoot, 'tasks');
    const conversationRoot = path.join(runRoot, 'conversations');

    const state: RunState = {
      run,
      tasks: [],
      worktreePath: cwd,
      workers: [],
      paths: { runRoot, tasksRoot, conversationRoot },
      lastEventAt: now,
      desiredCounts: { ...DEFAULT_COUNTS },
      modelPriority: { ...DEFAULT_PRIORITY }
    };
    await this.stopTaskWatcher(worktreeId);
    this.runs.set(worktreeId, state);
    const seeded = await this.taskStore.ensureAnalysisSeeds({
      worktreePath: state.worktreePath,
      tasksRoot,
      conversationRoot,
      runId: run.runId,
      description: run.description,
      guidance: run.guidance,
      epicId: run.epicId
    });
    state.tasks = seeded;
    this.scheduler.notifyTasksUpdated(worktreeId, state.tasks);
    await this.ensureTaskWatcher(worktreeId, state);
    this.bus.publish({ kind: 'snapshot', worktreeId, snapshot: this.cloneSnapshot(state) });
    this.bus.publish({ kind: 'run-status', worktreeId, run: state.run });
    return run;
  }

  async submitFollowUp(worktreeId: string, input: OrchestratorFollowUpInput): Promise<OrchestratorRunSummary> {
    const state = this.runs.get(worktreeId);
    if (!state) {
      throw new Error(`No orchestrator run for ${worktreeId}`);
    }
    const now = new Date().toISOString();
    state.run = {
      ...state.run,
      description: input.description,
      guidance: input.guidance,
      status: 'running',
      updatedAt: now
    };
    state.lastEventAt = now;
    await this.ensureTaskWatcher(worktreeId, state);
    this.bus.publish({ kind: 'run-status', worktreeId, run: state.run });
    return state.run;
  }

  async approveTask(worktreeId: string, taskId: string, approver: string): Promise<void> {
    const state = this.requireRun(worktreeId);
    if (!approver.trim()) {
      throw new Error('Approver name is required');
    }
    const record = await this.taskStore.approveTask({
      worktreePath: state.worktreePath,
      tasksRoot: state.paths.tasksRoot,
      conversationRoot: state.paths.conversationRoot,
      taskId,
      approver: approver.trim()
    });
    if (!record) {
      throw new Error(`Task ${taskId} not found for approval`);
    }
    this.mergeTaskUpdate(state, record, worktreeId);
  }

  async addComment(worktreeId: string, input: OrchestratorCommentInput): Promise<void> {
    const state = this.requireRun(worktreeId);
    if (!input.message.trim()) {
      throw new Error('Comment message cannot be empty');
    }
    const entry = await this.taskStore.appendConversationEntry({
      worktreePath: state.worktreePath,
      conversationRoot: state.paths.conversationRoot,
      taskId: input.taskId,
      input: { ...input, message: input.message.trim() }
    });
    this.bus.publish({ kind: 'conversation-appended', worktreeId, entry });
  }

  handleWorktreeRemoved(worktreeId: string): void {
    if (!this.runs.has(worktreeId)) {
      return;
    }
    void this.stopTaskWatcher(worktreeId);
    this.runs.delete(worktreeId);
  }

  dispose(): void {
    this.unsubscribeBus();
    this.bus.dispose();
    for (const [worktreeId, disposer] of this.taskWatchers.entries()) {
      void disposer().catch((error) => {
        console.warn('[orchestrator] failed to dispose watcher during shutdown', {
          worktreeId,
          message: (error as Error).message
        });
      });
    }
    this.taskWatchers.clear();
    this.runs.clear();
  }

  private cloneSnapshot(state: RunState): OrchestratorSnapshot {
    return {
      run: { ...state.run },
      tasks: state.tasks.map((task) => ({ ...task })),
      workers: (state.workers ?? []).map((worker) => ({ ...worker })),
      lastEventAt: state.lastEventAt,
      metadata: {
        implementerLockHeldBy: state.implementerLockHeldBy ?? null,
        workerCounts: { ...state.desiredCounts },
        modelPriority: { ...state.modelPriority }
      }
    };
  }

  getWorkerConfigurations(worktreeId: string): WorkerSpawnConfig[] {
    const state = this.runs.get(worktreeId);
    return WORKER_ROLES.map((role) => {
      const count = Math.max(0, state?.desiredCounts?.[role] ?? DEFAULT_COUNTS[role] ?? 0);
      const source = state?.modelPriority?.[role];
      const priority = (source && source.length > 0 ? source : DEFAULT_PRIORITY[role] ?? []).filter(Boolean).slice(0, 4);
      return { role, count, modelPriority: priority };
    });
  }

  updateWorkerConfigurations(worktreeId: string, configs: WorkerSpawnConfig[]): void {
    const state = this.runs.get(worktreeId);
    if (!state) {
      return;
    }
    let mutated = false;
    for (const config of configs) {
      if (config.count !== undefined) {
        const normalizedCount = Math.max(0, config.count);
        if (state.desiredCounts[config.role] !== normalizedCount) {
          state.desiredCounts[config.role] = normalizedCount;
          mutated = true;
        }
      }
      if (config.modelPriority && config.modelPriority.length > 0) {
        const next = config.modelPriority.filter(Boolean).slice(0, 4);
        const current = state.modelPriority[config.role] ?? DEFAULT_PRIORITY[config.role] ?? [];
        const sameLength = current.length === next.length;
        const sameValues = sameLength && current.every((value, index) => value === next[index]);
        if (!sameValues) {
          state.modelPriority[config.role] = next;
          mutated = true;
        }
      }
    }
    if (mutated) {
      state.lastEventAt = new Date().toISOString();
      this.bus.publish({ kind: 'snapshot', worktreeId, snapshot: this.cloneSnapshot(state) });
    }
  }

  private requireRun(worktreeId: string): RunState {
    const state = this.runs.get(worktreeId);
    if (!state) {
      throw new Error(`No orchestrator run for ${worktreeId}`);
    }
    return state;
  }

  private mergeTaskUpdate(
    state: RunState,
    record: TaskRecord,
    worktreeId: string,
    options?: { publishSnapshot?: boolean }
  ): void {
    const index = state.tasks.findIndex((task) => task.id === record.id);
    if (index >= 0) {
      state.tasks[index] = record;
    } else {
      state.tasks.push(record);
    }
    state.lastEventAt = new Date().toISOString();
    this.scheduler.notifyTasksUpdated(worktreeId, state.tasks);
    void this.ensureWorkflowExpansion(worktreeId, state).catch((error) => {
      console.warn('[orchestrator] workflow expansion failed', {
        worktreeId,
        message: (error as Error).message
      });
    });
    if (options?.publishSnapshot !== false) {
      this.bus.publish({ kind: 'snapshot', worktreeId, snapshot: this.cloneSnapshot(state) });
    }
  }

  private async ensureTaskWatcher(worktreeId: string, state: RunState): Promise<void> {
    if (this.taskWatchers.has(worktreeId)) {
      return;
    }
    const dispose = await this.taskStore.watchTasks(
      worktreeId,
      {
        worktreePath: state.worktreePath,
        tasksRoot: state.paths.tasksRoot,
        conversationRoot: state.paths.conversationRoot
      },
      (tasks) => {
        state.tasks = tasks;
        state.lastEventAt = new Date().toISOString();
        this.scheduler.notifyTasksUpdated(worktreeId, tasks);
        this.bus.publish({ kind: 'snapshot', worktreeId, snapshot: this.cloneSnapshot(state) });
      }
    );
    this.taskWatchers.set(worktreeId, dispose);
  }

  private async stopTaskWatcher(worktreeId: string): Promise<void> {
    const dispose = this.taskWatchers.get(worktreeId);
    if (!dispose) {
      return;
    }
    this.taskWatchers.delete(worktreeId);
    try {
      await dispose();
    } catch (error) {
      console.warn('[orchestrator] failed to stop task watcher', {
        worktreeId,
        message: (error as Error).message
      });
    }
  }

  private handleBusEvent(event: OrchestratorEvent): void {
    if (event.kind !== 'workers-updated') {
      return;
    }
    const state = this.runs.get(event.worktreeId);
    if (!state) {
      return;
    }
    const current = new Map((state.workers ?? []).map((worker) => [worker.id, worker]));
    let implementerLock: string | null = state.implementerLockHeldBy ?? null;
    for (const worker of event.workers) {
      current.set(worker.id, { ...worker });
      if (worker.role === 'implementer') {
        if (worker.state === 'working') {
          implementerLock = worker.id;
        } else if (worker.state === 'waiting' || worker.state === 'stopped' || worker.state === 'error') {
          implementerLock = null;
        }
      }
    }
    state.workers = Array.from(current.values());
    state.implementerLockHeldBy = implementerLock;
    state.lastEventAt = new Date().toISOString();
  }

  private async ensureWorkflowExpansion(worktreeId: string, state: RunState): Promise<void> {
    const mutated = await this.taskStore.ensureWorkflowExpansion({
      worktreePath: state.worktreePath,
      tasksRoot: state.paths.tasksRoot,
      conversationRoot: state.paths.conversationRoot,
      runId: state.run.runId,
      tasks: state.tasks
    });
    if (mutated) {
      // Reload tasks so snapshots include the freshly created entries immediately.
      const refreshed = await this.taskStore.loadTasks({
        worktreePath: state.worktreePath,
        tasksRoot: state.paths.tasksRoot,
        conversationRoot: state.paths.conversationRoot
      });
      state.tasks = refreshed;
      state.lastEventAt = new Date().toISOString();
      this.scheduler.notifyTasksUpdated(worktreeId, state.tasks);
      this.bus.publish({ kind: 'snapshot', worktreeId, snapshot: this.cloneSnapshot(state) });
    }
  }
}
