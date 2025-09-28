import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRole } from '../../../src/shared/orchestrator';

interface MockWorker {
  id: string;
  role: WorkerRole;
  model?: string;
  index: number;
  startCount: number;
  stopCount: number;
  started: boolean;
}

const registry: MockWorker[] = [];

vi.mock('../../../src/main/orchestrator/role-worker', async (importOriginal) => {
  const original = await importOriginal();
  class MockRoleWorker {
    id: string;
    role: WorkerRole;
    index: number;
    model?: string;
    started = false;
    startCount = 0;
    stopCount = 0;

    constructor(options: {
      id: string;
      role: WorkerRole;
      index: number;
      model?: string;
      context: unknown;
    }) {
      this.id = options.id;
      this.role = options.role;
      this.index = options.index;
      this.model = options.model;
      registry.push(this as unknown as MockWorker);
    }

    updateContext(): void {}

    start(): void {
      this.started = true;
      this.startCount += 1;
    }

    async stop(): Promise<void> {
      this.started = false;
      this.stopCount += 1;
    }

    getStatus() {
      const now = new Date().toISOString();
      return {
        id: this.id,
        role: this.role,
        state: this.started ? 'waiting' : 'stopped',
        description: this.started ? 'Waiting for tasks' : 'Stopped',
        updatedAt: now,
        startedAt: now,
        lastHeartbeatAt: now,
        model: this.model
      };
    }

    getRole(): WorkerRole {
      return this.role;
    }

    getIndex(): number {
      return this.index;
    }

    getModel(): string | undefined {
      return this.model;
    }
  }

  return {
    ...original,
    RoleWorker: MockRoleWorker,
    __getMockWorkers: () => registry
  };
});

import { WorkerSupervisor } from '../../../src/main/orchestrator/worker-supervisor';
import { OrchestratorEventBus } from '../../../src/main/orchestrator/event-bus';
import type { TaskClaimStore } from '../../../src/main/orchestrator/task-claim-store';
import type { CodexExecutor } from '../../../src/main/orchestrator/codex-executor';
import * as RoleWorkerModule from '../../../src/main/orchestrator/role-worker';

const getMockWorkers = (): MockWorker[] => {
  return (RoleWorkerModule as unknown as { __getMockWorkers: () => MockWorker[] }).__getMockWorkers();
};

const createSupervisor = () => {
  const bus = new OrchestratorEventBus();
  const claimStore = {} as TaskClaimStore;
  const executorFactory = (): CodexExecutor => ({
    execute: vi.fn(async () => ({ summary: '', artifacts: [] }))
  });
  const supervisor = new WorkerSupervisor(bus, claimStore, executorFactory);
  supervisor.registerContext('wt', {
    worktreeId: 'wt',
    runId: 'run-1',
    runRoot: '/tmp/run-1',
    options: {
      worktreePath: '/tmp/worktree',
      tasksRoot: '/tmp/tasks',
      conversationRoot: '/tmp/conversations'
    }
  });
  return supervisor;
};

describe('WorkerSupervisor.configure', () => {
  beforeEach(() => {
    getMockWorkers().length = 0;
  });

  it('spawns multiple workers per role with model priority ordering', async () => {
    const supervisor = createSupervisor();
    await supervisor.configure('wt', [
      { role: 'reviewer', count: 2, modelPriority: ['gpt-5-codex-high', 'gpt-5-high'] },
      { role: 'implementer', count: 1, modelPriority: ['gpt-5-codex-medium'] }
    ]);

    const reviewers = getMockWorkers().filter((worker) => worker.role === 'reviewer');
    expect(reviewers).toHaveLength(2);
    expect(reviewers.map((worker) => worker.model)).toEqual([
      'gpt-5-codex-high',
      'gpt-5-high'
    ]);
    const statuses = supervisor.getStatuses('wt');
    expect(statuses.find((status) => status.id === 'reviewer-1')?.model).toBe('gpt-5-codex-high');
    expect(statuses.find((status) => status.id === 'reviewer-2')?.model).toBe('gpt-5-high');

    await supervisor.dispose();
  });

  it('stops excess workers when count decreases and swaps models when changed', async () => {
    const supervisor = createSupervisor();
    await supervisor.configure('wt', [
      { role: 'reviewer', count: 2, modelPriority: ['gpt-5-codex-high', 'gpt-5-codex-medium'] }
    ]);

    const initialWorkers = [...getMockWorkers()].filter((worker) => worker.role === 'reviewer');
    expect(initialWorkers).toHaveLength(2);

    await supervisor.configure('wt', [
      { role: 'reviewer', count: 1, modelPriority: ['gpt-5-high'] }
    ]);

    const statuses = supervisor.getStatuses('wt');
    const reviewerStatus = statuses.find((status) => status.role === 'reviewer');
    expect(reviewerStatus).toBeDefined();
    expect(reviewerStatus?.model).toBe('gpt-5-high');
    const retired = initialWorkers.find((worker) => worker.id === 'reviewer-2');
    expect(retired?.stopCount).toBeGreaterThanOrEqual(1);

    await supervisor.dispose();
  });
});
