import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerSpawnConfig } from '../../../src/shared/orchestrator-config';
import type { WorkerContextPayload } from '../../../src/shared/orchestrator-ipc';

const mockWorkers: MockWorker[] = [];

class MockWorker {
  public readonly messages: unknown[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  public terminated = false;
  constructor(public readonly entry: string) {
    mockWorkers.push(this);
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
  }
  postMessage(message: unknown) {
    this.messages.push(message);
    if (typeof message === 'object' && message && (message as { type?: string }).type === 'dispose') {
      queueMicrotask(() => {
        this.emit('message', { id: (message as { id: string }).id, ok: true });
      });
    }
  }
  emit(event: string, payload?: unknown) {
    const handlers = this.listeners.get(event) ?? [];
    for (const handler of handlers) {
      handler(payload);
    }
  }
  terminate(): Promise<void> {
    this.terminated = true;
    return Promise.resolve();
  }
}

vi.mock('node:worker_threads', () => ({
  Worker: MockWorker,
  parentPort: null,
  isMainThread: true,
  default: { Worker: MockWorker }
}));

const importBridge = async () => {
  const module = await import('../../../src/main/orchestrator/worker-bridge');
  return module.WorkerOrchestratorBridge;
};

describe('WorkerOrchestratorBridge', () => {
  beforeEach(() => {
    mockWorkers.splice(0, mockWorkers.length);
  });

  it('resolves requests when worker responds', async () => {
    const WorkerOrchestratorBridge = await importBridge();
    const bridge = new WorkerOrchestratorBridge(() => '/tmp/worktree');
    const worker = mockWorkers.at(-1);
    expect(worker).toBeDefined();
    if (!worker) return;

    const snapshotPromise = bridge.getSnapshot('wt-1');
    const message = worker.messages.at(-1) as { id: string; type: string };
    expect(message.type).toBe('get-snapshot');

    worker.emit('message', {
      id: message.id,
      ok: true,
      result: {
        run: {
          worktreeId: 'wt-1',
          runId: 'run-1',
          epicId: null,
          status: 'running',
          description: 'test',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        tasks: [],
        workers: [],
        metadata: { implementerLockHeldBy: null }
      }
    });

    await expect(snapshotPromise).resolves.toMatchObject({ run: { worktreeId: 'wt-1' } });
    await bridge.dispose();
  });

  it('rejects pending requests and respawns on worker error', async () => {
    const WorkerOrchestratorBridge = await importBridge();
    const bridge = new WorkerOrchestratorBridge(() => '/tmp/worktree');
    const worker = mockWorkers.at(-1)!;

    const promise = bridge.getSnapshot('wt-error');
    const message = worker.messages.at(-1) as { id: string };
    expect(message).toBeDefined();

    worker.emit('error', new Error('boom'));

    await expect(promise).rejects.toThrow('boom');
    expect(mockWorkers.length).toBe(2);

    const newWorker = mockWorkers.at(-1)!;
    const second = bridge.getSnapshot('wt-error');
    const secondMessage = newWorker.messages.at(-1) as { id: string };
    newWorker.emit('message', {
      id: secondMessage.id,
      ok: true,
      result: {
        run: {
          worktreeId: 'wt-error',
          runId: 'run-2',
          epicId: null,
          status: 'running',
          description: 'second',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        tasks: [],
        workers: [],
        metadata: { implementerLockHeldBy: null }
      }
    });
    await expect(second).resolves.toMatchObject({ run: { runId: 'run-2' } });
    await bridge.dispose();
  });

  it('respawns worker on exit and serves subsequent requests', async () => {
    const WorkerOrchestratorBridge = await importBridge();
    const bridge = new WorkerOrchestratorBridge(() => '/tmp/worktree');
    const firstWorker = mockWorkers.at(-1)!;

    const inFlight = bridge.getSnapshot('wt-exit');
    const firstMessage = firstWorker.messages.at(-1) as { id: string };
    expect(firstMessage).toBeDefined();

    firstWorker.emit('exit', 1);
    await expect(inFlight).rejects.toThrow('code 1');
    expect(mockWorkers.length).toBe(2);

    const secondWorker = mockWorkers.at(-1)!;
    const next = bridge.getSnapshot('wt-exit');
    const nextMessage = secondWorker.messages.at(-1) as { id: string };
    secondWorker.emit('message', {
      id: nextMessage.id,
      ok: true,
      result: {
        run: {
          worktreeId: 'wt-exit',
          runId: 'run-3',
          epicId: null,
          status: 'running',
          description: 'recovered',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        tasks: [],
        workers: [],
        metadata: { implementerLockHeldBy: null }
      }
    });
    await expect(next).resolves.toMatchObject({ run: { description: 'recovered' } });
    await bridge.dispose();
  });

  it('propagates worker errors when starting workers and supports retry', async () => {
    const WorkerOrchestratorBridge = await importBridge();
    const bridge = new WorkerOrchestratorBridge(() => '/tmp/worktree');
    const worker = mockWorkers.at(-1)!;

    const context: WorkerContextPayload = {
      worktreePath: '/tmp/worktree',
      runId: 'run-ctx',
      runRoot: '/tmp/run-root',
      tasksRoot: '/tmp/tasks',
      conversationRoot: '/tmp/conversations'
    };
    const configs: WorkerSpawnConfig[] = [
      { role: 'implementer', count: 1, modelPriority: ['gpt-5-codex-high'] }
    ];

    const promise = bridge.startWorkers('wt-config', context, configs);
    const message = worker.messages.at(-1) as {
      id: string;
      type: string;
      worktreeId: string;
      context: WorkerContextPayload;
      configs: WorkerSpawnConfig[];
    };

    expect(message.type).toBe('start-workers');
    expect(message.worktreeId).toBe('wt-config');
    expect(message.context).toEqual(context);
    expect(message.configs).toEqual(configs);

    worker.emit('message', { id: message.id, ok: false, error: 'failed to launch' });
    await expect(promise).rejects.toThrow('failed to launch');

    const retry = bridge.startWorkers('wt-config', context, configs);
    const retryMessage = worker.messages.at(-1) as { id: string };
    worker.emit('message', { id: retryMessage.id, ok: true });
    await expect(retry).resolves.toBeUndefined();

    await bridge.dispose();
  });
});
