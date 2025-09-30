import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeAuditLog } from '../../../../src/main/services/WorktreeAuditLog';
import type { WorktreeOperationLogEntry } from '../../../../src/shared/ipc';

describe('WorktreeAuditLog', () => {
  it('appends entries as JSON lines', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'audit-log-'));
    const log = new WorktreeAuditLog(tempDir);
    const entry: WorktreeOperationLogEntry = {
      timestamp: new Date().toISOString(),
      worktreeId: 'wt-abc',
      actor: 'tester',
      action: 'pull',
      outcome: 'success',
      detail: 'merged origin/main'
    };

    await log.append(entry);

    const filePath = path.join(tempDir, 'wt-abc.jsonl');
    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(entry);
  });
});
