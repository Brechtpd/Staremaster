import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../../../src/main/orchestrator/task-store';

const RUN_ID = 'RUN-PIPELINE';

const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
};

const writeJson = async (filePath: string, payload: Record<string, unknown>): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

describe('TaskStore workflow expansion', () => {
  let tempDir: string;
  let tasksRoot: string;
  let conversationRoot: string;
  let store: TaskStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'task-store-expansion-'));
    tasksRoot = path.join(tempDir, 'codex-runs', RUN_ID, 'tasks');
    conversationRoot = path.join(tempDir, 'codex-runs', RUN_ID, 'conversations');
    store = new TaskStore();
    await store.ensureAnalysisSeeds({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      description: 'Initial feasibility analysis',
      guidance: 'Keep drafts focused'
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const setStatus = async (id: string, status: string): Promise<void> => {
    const entries = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const entry = entries.find((item) => item.record.id === id);
    if (!entry) {
      throw new Error(`Task ${id} not found`);
    }
    const payload = await readJson(entry.filePath);
    payload.status = status;
    payload.updated_at = new Date().toISOString();
    await writeJson(entry.filePath, payload);
  };

  it('creates consensus after analysts finish', async () => {
    const analysisTasks = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    for (const task of analysisTasks) {
      await setStatus(task.record.id, 'done');
    }

    const tasks = (await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    })).map((entry) => entry.record);
    const mutated = await store.ensureWorkflowExpansion({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      tasks
    });

    expect(mutated).toBe(true);
    const consensusEntries = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    expect(consensusEntries.some((entry) => entry.record.kind === 'consensus')).toBe(true);
  });

  it('creates splitter after consensus completion', async () => {
    const initialEntries = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const analystA = initialEntries[0];
    const analystB = initialEntries[1];
    await setStatus(analystA.record.id, 'done');
    await setStatus(analystB.record.id, 'done');
    const afterDone = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    await store.ensureWorkflowExpansion({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      tasks: afterDone.map((entry) => entry.record)
    });

    const consensusEntry = (await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    })).find((entry) => entry.record.kind === 'consensus');
    expect(consensusEntry).toBeDefined();
    if (!consensusEntry) return;

    await setStatus(consensusEntry.record.id, 'done');
    const mutated = await store.ensureWorkflowExpansion({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      tasks: [analystA.record, analystB.record, { ...consensusEntry.record, status: 'done' }]
    });

    expect(mutated).toBe(true);
    const entries = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    expect(entries.some((entry) => entry.record.role === 'splitter')).toBe(true);
  });

  it('creates implementer tester reviewer after splitter completion', async () => {
    const entries = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    for (const entry of entries) {
      if (entry.record.kind === 'analysis') {
        await setStatus(entry.record.id, 'done');
      }
    }
    const afterAnalystsEntries = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const afterAnalysts = afterAnalystsEntries.map((entry) => entry.record);
    await store.ensureWorkflowExpansion({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      tasks: afterAnalysts
    });

    const afterConsensus = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const consensus = afterConsensus.find((entry) => entry.record.kind === 'consensus');
    expect(consensus).toBeDefined();
    if (!consensus) return;
    await setStatus(consensus.record.id, 'done');
    await store.ensureWorkflowExpansion({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      tasks: (await store.readTaskEntries({
        worktreePath: tempDir,
        tasksRoot,
        conversationRoot
      })).map((entry) => entry.record)
    });

    const withSplitter = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const splitter = withSplitter.find((entry) => entry.record.role === 'splitter');
    expect(splitter).toBeDefined();
    if (!splitter) return;
    await setStatus(splitter.record.id, 'done');

    const mutated = await store.ensureWorkflowExpansion({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      tasks: (await store.readTaskEntries({
        worktreePath: tempDir,
        tasksRoot,
        conversationRoot
      })).map((entry) => entry.record)
    });

    expect(mutated).toBe(true);
    const finalEntries = await store.readTaskEntries({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const roles = finalEntries.map((entry) => entry.record.role);
    expect(roles).toContain('implementer');
    expect(roles).toContain('tester');
    expect(roles).toContain('reviewer');
  });
});
