import type { OrchestratorEventBus } from './event-bus';
import type { TaskRecord } from '@shared/orchestrator';

export class OrchestratorScheduler {
  constructor(private readonly bus: OrchestratorEventBus) {}

  notifyTasksUpdated(worktreeId: string, tasks: TaskRecord[]): void {
    this.bus.publish({ kind: 'tasks-updated', worktreeId, tasks });
  }
}
