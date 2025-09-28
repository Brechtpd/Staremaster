import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const CODEx_BIN = process.env.CODEX_ORCHESTRATOR_BIN ?? 'codex-orchestrator';

const binaryAvailable = (() => {
  try {
    const result = spawnSync(CODEx_BIN, ['--help'], { stdio: 'ignore' });
    return result.error == null && result.status === 0;
  } catch (error) {
    return false;
  }
})();

describe.skipIf(!binaryAvailable)('codex-orchestrator CLI', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('seeds example tasks into the repository', async () => {
    const child = spawn(CODEx_BIN, ['task', 'seed-example'], { cwd: tempDir, stdio: 'inherit' });
    const exitCode: number = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 0));
    });
    expect(exitCode).toBe(0);

    const tasksDir = path.join(tempDir, '.codex', 'tasks', 'analysis');
    const files = await readdir(tasksDir);
    expect(files.some((file) => file.endsWith('.json'))).toBe(true);
  });
});
