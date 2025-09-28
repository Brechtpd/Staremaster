/* eslint-disable no-console */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { OrchestratorEventBus } from '../../../src/main/orchestrator/event-bus';
import { TaskStore } from '../../../src/main/orchestrator/task-store';
import { TaskClaimStore } from '../../../src/main/orchestrator/task-claim-store';
import { WorkerSupervisor } from '../../../src/main/orchestrator/worker-supervisor';
import { CodexCliExecutor } from '../../../src/main/orchestrator/codex-executor';

const CODEx_BIN = process.env.CODEX_BIN ?? 'codex';
const RUN_REAL = process.env.RUN_REAL_CODEX_E2E === '1';

const codexAvailable = (() => {
  try {
    const result = spawnSync(CODEx_BIN, ['--version'], { stdio: 'ignore' });
    return result.error == null && result.status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!RUN_REAL || !codexAvailable)('Codex workers — real CLI integration', () => {
  let tempDir: string;
  let runRoot: string;
  let tasksRoot: string;
  let conversationRoot: string;
  let store: TaskStore;
  let claims: TaskClaimStore;
  let supervisor: WorkerSupervisor;
  let bus: OrchestratorEventBus;
  let unsubscribe: () => void;
  const worktreeId = 'wt-e2e';
  const runId = 'RUN-E2E';

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-e2e-'));
    spawnSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    runRoot = path.join(tempDir, 'codex-runs', runId);
    tasksRoot = path.join(runRoot, 'tasks');
    conversationRoot = path.join(runRoot, 'conversations');
    store = new TaskStore();
    claims = new TaskClaimStore(store);
    bus = new OrchestratorEventBus();
    unsubscribe = bus.subscribe((event) => {
      switch (event.kind) {
        case 'workers-updated': {
          for (const worker of event.workers) {
            console.log(`[e2e] worker ${worker.role} → ${worker.state} (${worker.description ?? 'no message'})`);
          }
          break;
        }
        case 'worker-log': {
          const snippet = event.chunk.trim().slice(0, 160).replace(/\s+/g, ' ');
          if (snippet) {
            console.log(`[e2e] log[${event.role}] ${snippet}`);
          }
          break;
        }
        case 'snapshot': {
          console.log(`[e2e] snapshot update — ${event.snapshot.tasks.length} tasks, ${event.snapshot.workers.length} workers`);
          break;
        }
        default:
          break;
      }
    });
    supervisor = new WorkerSupervisor(bus, claims, () => new CodexCliExecutor());

    await store.ensureAnalysisSeeds({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId,
      description:
        'Design, implement, test, and review a simple terminal Pong game in Rust. Support score keeping and basic AI paddle.',
      guidance:
        'Focus on a readable architecture (game loop, input handling, rendering) and produce high-level requirements before implementation.'
    });

    supervisor.registerContext(worktreeId, {
      worktreeId,
      runId,
      runRoot,
      options: {
        worktreePath: tempDir,
        tasksRoot,
        conversationRoot
      }
    });

    const seeded = await store.loadTasks({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    console.log(`[e2e] seeded ${seeded.length} tasks in ${tasksRoot}`);
  });

  afterEach(async () => {
    await supervisor.stopAll(worktreeId).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
    unsubscribe?.();
  });

  const loadAnalysisTask = async () => {
    const entries = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    return entries.find((entry) => entry.record.role === 'analyst_a');
  };

  const waitFor = async <T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 90_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let last: T;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      last = await fn();
      if (predicate(last)) {
        return last;
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for condition');
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  };

  it('completes an analysis task end to end', async () => {
    await supervisor.startRoles(worktreeId, ['analyst_a']);
    console.log('[e2e] analyst_a worker started');

    const entry = await waitFor(async () => loadAnalysisTask(), (task) => Boolean(task));
    if (!entry) {
      throw new Error('analysis task not created');
    }

    let finalEntry;
    try {
      finalEntry = await waitFor(async () => loadAnalysisTask(), (task) => task?.record.status === 'done');
    } catch (error) {
      const latest = await loadAnalysisTask();
      // eslint-disable-next-line no-console
      console.error('[e2e] latest task snapshot', latest?.record.status, latest?.record.summary);
      throw error;
    }

    expect(finalEntry?.record.status).toBe('done');
    expect((finalEntry?.record.summary ?? '').length).toBeGreaterThan(10);
    console.log('[e2e] worker finished', finalEntry?.record.summary);

    const artifact = finalEntry?.record.artifacts?.[0];
    expect(artifact).toBeTruthy();
    if (artifact) {
      const artifactPath = path.join(tempDir, artifact);
      await expect(stat(artifactPath)).resolves.toMatchObject({});
      const contents = await readFile(artifactPath, 'utf8');
      expect(contents.toLowerCase()).toContain('requirements');
      console.log('[e2e] artifact written', artifactPath);
    }
  }, 120_000);
});
