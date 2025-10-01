import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../../../src/main/orchestrator/task-store';
import { TaskClaimStore } from '../../../src/main/orchestrator/task-claim-store';

const RUN_ID = 'run-test';

describe('TaskClaimStore', () => {
  let tempDir: string;
  let tasksRoot: string;
  let conversationRoot: string;
  let store: TaskStore;
  let claimStore: TaskClaimStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'claim-store-'));
    tasksRoot = path.join(tempDir, 'codex-runs', RUN_ID, 'tasks');
    conversationRoot = path.join(tempDir, 'codex-runs', RUN_ID, 'conversations');
    store = new TaskStore();
    claimStore = new TaskClaimStore(store);
    await store.ensureAnalysisSeeds({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      description: 'Analyse the onboarding flow',
      guidance: 'Consider error states',
      epicId: 'EPIC-001'
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('claims ready tasks and marks them done', async () => {
    const claim = await claimStore.claimNext({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      role: 'analyst_a'
    });

    expect(claim).not.toBeNull();
    if (!claim) return;

    const outcome = {
      status: 'ok' as const,
      summary: 'Drafted initial requirements',
      details: 'Outlined scope and acceptance criteria.'
    };
    const done = await claimStore.markDone(claim, {
      summary: 'Drafted initial requirements',
      artifacts: ['codex-runs/run-test/artifacts/ANALYSIS-run-test-A.md'],
      workerOutcome: outcome
    });

    expect(done).not.toBeNull();
    expect(done?.status).toBe('done');
    expect(done?.summary).toContain('Drafted initial requirements');

    const payload = JSON.parse(await readFile(claim.entry.filePath, 'utf8')) as Record<string, unknown>;
    expect(payload.status).toBe('done');
    expect(payload.summary).toContain('Drafted initial requirements');
    expect(Array.isArray(payload.artifacts)).toBe(true);
    const storedOutcome = payload.worker_outcome as { status?: string; summary?: string } | undefined;
    expect(storedOutcome?.status).toBe('ok');
    expect(storedOutcome?.summary).toContain('Drafted initial requirements');
  });

  it('marks tasks as blocked on failure and releases locks', async () => {
    const claim = await claimStore.claimNext({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      role: 'analyst_b'
    });

    expect(claim).not.toBeNull();
    if (!claim) return;

    const blocked = await claimStore.markBlocked(claim, 'Executor crashed');
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.summary).toContain('Executor crashed');

    const retry = await claimStore.claimNext({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      role: 'analyst_b'
    });
    expect(retry).toBeNull();
  });

  it('respects dependencies before claiming', async () => {
    const claimAnalystA = await claimStore.claimNext({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      role: 'analyst_a'
    });
    const claimAnalystB = await claimStore.claimNext({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      role: 'analyst_b'
    });
    expect(claimAnalystA).not.toBeNull();
    expect(claimAnalystB).not.toBeNull();
    if (!claimAnalystA || !claimAnalystB) {
      return;
    }

    await claimStore.markDone(claimAnalystA, { summary: 'done' });
    await claimStore.markDone(claimAnalystB, { summary: 'done' });

    const analysisTasks = (await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    })).map((entry) => entry.record);
    await store.ensureWorkflowExpansion({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      tasks: analysisTasks,
      mode: 'implement_feature',
      description: 'Prototype'
    });

    const afterExpansion = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const consensusEntry = afterExpansion.find((entry) => entry.record.kind === 'consensus');
    expect(consensusEntry).toBeDefined();
    if (!consensusEntry) return;
    const claimConsensus = await claimStore.claimNext({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      role: 'consensus_builder'
    });
    expect(claimConsensus).not.toBeNull();
    if (!claimConsensus) return;
    await claimStore.markDone(claimConsensus, { summary: 'merged drafts' });

    const withConsensusDone = (await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    })).map((entry) => entry.record);
    await store.ensureWorkflowExpansion({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      tasks: withConsensusDone,
      mode: 'implement_feature',
      description: 'Prototype'
    });

    const afterSplitterExpansion = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const splitter = afterSplitterExpansion.find((entry) => entry.record.role === 'splitter');
    expect(splitter).toBeDefined();
    if (!splitter) return;

    const claimImplementerBefore = await claimStore.claimNext({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      role: 'implementer'
    });
    expect(claimImplementerBefore).toBeNull();

    const claimSplitter = await claimStore.claimNext({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      role: 'splitter'
    });
    expect(claimSplitter).not.toBeNull();
    if (!claimSplitter) return;
    await claimStore.markDone(claimSplitter, { summary: 'plan ready' });

    const withSplitterDone = (await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    })).map((entry) => entry.record);
    await store.ensureWorkflowExpansion({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      tasks: withSplitterDone,
      mode: 'implement_feature',
      description: 'Prototype'
    });

    const claimImplementerAfter = await claimStore.claimNext({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      role: 'implementer'
    });
    expect(claimImplementerAfter).not.toBeNull();
  });
});
