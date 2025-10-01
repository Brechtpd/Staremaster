import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TesterExecutor } from '../../../src/main/orchestrator/tester-executor';
import type { ExecutionContext } from '../../../src/main/orchestrator/codex-executor';

const createContext = (worktree: string): ExecutionContext => ({
  worktreePath: worktree,
  runId: 'RUN',
  task: {
    id: 'TEST',
    title: 'Test task',
    prompt: 'run tests',
    status: 'ready',
    kind: 'test',
    role: 'tester',
    cwd: '.',
    dependsOn: [],
    approvalsRequired: 0,
    approvals: [],
    artifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    epicId: 'RUN'
  } as unknown as ExecutionContext['task'],
  role: 'tester',
  onLog: () => undefined,
  signal: new AbortController().signal
});

describe('TesterExecutor', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'tester-executor-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs configured command and captures output', async () => {
    const executor = new TesterExecutor({ command: 'echo running-tests' });
    const result = await executor.execute(createContext(tempDir));
    expect(result.summary).toContain('Test command succeeded');
    expect(result.artifacts[0].contents.trim()).toBe('running-tests');
    expect(result.outcome.status).toBe('ok');
    expect(result.outcome.summary).toContain('Test command succeeded');
  });
});
