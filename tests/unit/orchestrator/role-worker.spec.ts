import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RoleWorker } from '../../../src/main/orchestrator/role-worker';
import { OrchestratorEventBus } from '../../../src/main/orchestrator/event-bus';
import { TaskClaimStore } from '../../../src/main/orchestrator/task-claim-store';
import { TaskStore } from '../../../src/main/orchestrator/task-store';
import type { CodexExecutor, ExecutionContext, ExecutionResult } from '../../../src/main/orchestrator/codex-executor';

const RUN_ID = 'role-worker-run';

class ResolvingExecutor implements CodexExecutor {
  constructor(private readonly result: ExecutionResult) {}

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    context.onLog('executor started\n', 'stdout');
    return this.result;
  }
}

class FailingExecutor implements CodexExecutor {
  constructor(private readonly message = 'executor failure') {}

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    context.onLog('executor failed\n', 'stderr');
    throw new Error(this.message);
  }
}

const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 4000, stepMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw lastError ?? new Error('Timed out waiting for condition');
};

describe('RoleWorker', () => {
  let tempDir: string;
  let runRoot: string;
  let tasksRoot: string;
  let conversationRoot: string;
  let store: TaskStore;
  let claimStore: TaskClaimStore;
  let bus: OrchestratorEventBus;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'role-worker-'));
    runRoot = path.join(tempDir, 'codex-runs', RUN_ID);
    tasksRoot = path.join(runRoot, 'tasks');
    conversationRoot = path.join(runRoot, 'conversations');
    store = new TaskStore();
    claimStore = new TaskClaimStore(store);
    bus = new OrchestratorEventBus();
    await store.ensureAnalysisSeeds({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      description: 'Evaluate new login UX',
      guidance: 'Capture positive and negative flows'
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const context = () => ({
    worktreeId: 'wt-1',
    runId: RUN_ID,
    runRoot,
    options: {
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    }
  });

  const loadTaskPayload = async (file: string) => {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  };

  it('completes tasks and writes artifacts on success', async () => {
    const executor = new ResolvingExecutor({
      summary: 'Generated requirements',
      artifacts: [
        {
          path: 'artifacts/ANALYSIS-success.md',
          contents: '# Generated requirements\n\n- Flow overview\n'
        }
      ],
      outcome: {
        status: 'ok',
        summary: 'Requirements ready for consensus review.',
        details: 'Document covers scope, risks, and acceptance criteria.'
      }
    });

    const worker = new RoleWorker({
      role: 'analyst_a',
      bus,
      claimStore,
      executor,
      context: context()
    });

    const events: string[] = [];
    const unsubscribe = bus.subscribe((event) => {
      events.push(event.kind);
    });

    worker.start();

    const entries = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const entry = entries.find((item) => item.record.role === 'analyst_a');
    expect(entry).toBeDefined();
    if (!entry) {
      await worker.stop();
      unsubscribe();
      return;
    }

    await waitFor(async () => {
      const payload = await loadTaskPayload(entry.filePath);
      return payload.status === 'done';
    });

    const payload = await loadTaskPayload(entry.filePath);
    expect(payload.status).toBe('done');
    expect(payload.summary).toContain('Requirements ready for consensus review.');
    expect(Array.isArray(payload.artifacts)).toBe(true);
    const workerOutcome = payload.worker_outcome as { status?: string; summary?: string; details?: string; document_path?: string };
    expect(workerOutcome).toBeDefined();
    expect(workerOutcome.status).toBe('ok');
    expect(workerOutcome.summary).toContain('Requirements ready');
    const artifactList = Array.isArray(payload.artifacts) ? payload.artifacts.map(String) : [];
    expect(artifactList.some((item) => item.endsWith('.outcome.json'))).toBe(true);

    const artifactPath = path.join(tempDir, String(payload.artifacts?.[0]));
    await expect(stat(artifactPath)).resolves.toMatchObject({});
    const outcomeArtifact = workerOutcome?.document_path
      ? path.join(tempDir, workerOutcome.document_path)
      : artifactList
          .map((item) => path.join(tempDir, item))
          .find((candidate) => candidate.endsWith('.outcome.json'));
    if (outcomeArtifact) {
      await expect(stat(outcomeArtifact)).resolves.toMatchObject({});
    }

    expect(events.some((kind) => kind === 'worker-log')).toBe(true);

    await worker.stop();
    unsubscribe();
  });

  it.each([
    { outcomeStatus: 'ok' as const, expectedStatus: 'approved' },
    { outcomeStatus: 'changes_requested' as const, expectedStatus: 'changes_requested' }
  ])('applies reviewer outcome status %s', async ({ outcomeStatus, expectedStatus }) => {
    const reviewDir = path.join(tasksRoot, 'review');
    await mkdir(reviewDir, { recursive: true });
    const taskId = `REVIEW-${outcomeStatus.toUpperCase()}`;
    const taskPath = path.join(reviewDir, `${taskId}.json`);
    const now = new Date().toISOString();
    const reviewPayload = {
      id: taskId,
      epic: RUN_ID,
      kind: 'review',
      role: 'reviewer',
      title: 'Reviewer validation',
      prompt: 'Review implementer output for correctness.',
      status: 'ready',
      cwd: '.',
      depends_on: [],
      approvals_required: 1,
      approvals: [],
      artifacts: [],
      created_at: now,
      updated_at: now
    } as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify(reviewPayload, null, 2)}\n`, 'utf8');

    const executor = new ResolvingExecutor({
      summary: 'Reviewer outcome summary',
      artifacts: [],
      outcome: {
        status: outcomeStatus,
        summary: outcomeStatus === 'ok' ? 'All checks passed.' : 'Further changes required.',
        details: 'Structured reviewer output.'
      }
    });

    const worker = new RoleWorker({
      role: 'reviewer',
      bus,
      claimStore,
      executor,
      context: context()
    });

    worker.start();

    await waitFor(async () => {
      const payload = await loadTaskPayload(taskPath);
      return payload.status === expectedStatus;
    });

    const payload = await loadTaskPayload(taskPath);
    const workerOutcome = payload.worker_outcome as { status?: string } | undefined;
    expect(workerOutcome?.status).toBe(outcomeStatus);
    expect(payload.status).toBe(expectedStatus);

    await worker.stop();
  });

  it('marks tasks blocked when executor throws', async () => {
    const worker = new RoleWorker({
      role: 'analyst_b',
      bus,
      claimStore,
      executor: new FailingExecutor('prompt failed'),
      context: context()
    });

    worker.start();

    const entries = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const entry = entries.find((item) => item.record.role === 'analyst_b');
    expect(entry).toBeDefined();
    if (!entry) {
      await worker.stop();
      return;
    }

    await waitFor(async () => {
      const payload = await loadTaskPayload(entry.filePath);
      return payload.status === 'blocked';
    });

    const payload = await loadTaskPayload(entry.filePath);
    expect(payload.status).toBe('blocked');
    expect(payload.summary).toContain('prompt failed');

    const status = worker.getStatus();
    expect(status.state === 'error' || status.state === 'waiting').toBe(true);

    await worker.stop();
  });
});
