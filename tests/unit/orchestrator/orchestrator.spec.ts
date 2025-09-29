import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OrchestratorCoordinator } from '../../../src/main/orchestrator';

describe('OrchestratorCoordinator', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('seeds analysis tasks and reports them in snapshot', async () => {
    const coordinator = new OrchestratorCoordinator(() => tempDir);

    await coordinator.startRun('wt', {
      description: 'Document expected UI changes for onboarding flow',
      autoStartWorkers: false
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshot = await coordinator.getSnapshot('wt');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.tasks.length).toBeGreaterThanOrEqual(2);
    expect(snapshot?.tasks.every((task) => task.kind === 'analysis')).toBe(true);
    expect(snapshot?.metadata?.workerCounts?.implementer).toBe(1);
    expect(snapshot?.metadata?.modelPriority?.reviewer?.[0]).toBe('gpt-5-codex');

    const runsDir = path.join(tempDir, 'codex-runs');
    const runFolders = await readdir(runsDir);
    expect(runFolders.length).toBe(1);
    const analysisDir = path.join(runsDir, runFolders[0], 'tasks', 'analysis');
    const files = await readdir(analysisDir);
    expect(files.some((file) => file.endsWith('.json'))).toBe(true);

    await coordinator.dispose();
  });

  it('returns null snapshot for unknown worktree', async () => {
    const coordinator = new OrchestratorCoordinator(() => null);
    const snapshot = await coordinator.getSnapshot('missing');
    expect(snapshot).toBeNull();
    coordinator.dispose();
  });

  it('tracks worker status updates emitted on the bus', async () => {
    const coordinator = new OrchestratorCoordinator(() => tempDir);
    await coordinator.startRun('wt', {
      description: 'Instrument consensus step',
      autoStartWorkers: false
    });

    const internal = coordinator as unknown as {
      handleBusEvent: (event: unknown) => void;
    };

    internal.handleBusEvent({
      kind: 'workers-updated',
      worktreeId: 'wt',
      workers: [
        {
          id: 'analyst_a',
          role: 'analyst_a',
          state: 'waiting',
          updatedAt: new Date().toISOString(),
          description: 'Waiting for tasks'
        }
      ]
    });

    const snapshot = await coordinator.getSnapshot('wt');
    expect(snapshot?.workers.length).toBe(1);
    expect(snapshot?.workers[0].role).toBe('analyst_a');

    await coordinator.dispose();
  });

  it('updates worker configuration counts and priorities', async () => {
    const coordinator = new OrchestratorCoordinator(() => tempDir);
    await coordinator.startRun('wt', {
      description: 'Tune reviewer models',
      autoStartWorkers: false
    });

    coordinator.updateWorkerConfigurations('wt', [
      { role: 'reviewer', count: 2, modelPriority: ['gpt-5-high', 'gpt-5-medium'] }
    ]);

    const configs = coordinator.getWorkerConfigurations('wt');
    const reviewer = configs.find((config) => config.role === 'reviewer');
    expect(reviewer?.count).toBe(2);
    expect(reviewer?.modelPriority[0]).toBe('gpt-5-high');
    expect(reviewer?.modelPriority).toEqual(['gpt-5-high', 'gpt-5-medium']);

    const snapshot = await coordinator.getSnapshot('wt');
    expect(snapshot?.metadata?.workerCounts?.reviewer).toBe(2);
    expect(snapshot?.metadata?.modelPriority?.reviewer?.[0]).toBe('gpt-5-high');

    await coordinator.dispose();
  });
});
