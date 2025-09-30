import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorktreeOperationLogEntry } from '../../shared/ipc';

export class WorktreeAuditLog {
  constructor(private readonly baseDir: string) {}

  async append(entry: WorktreeOperationLogEntry): Promise<void> {
    const normalized: WorktreeOperationLogEntry = {
      ...entry,
      timestamp: entry.timestamp ?? new Date().toISOString()
    };
    const targetPath = this.resolvePath(normalized.worktreeId);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.appendFile(targetPath, `${JSON.stringify(normalized)}\n`, 'utf8');
  }

  resolvePath(worktreeId: string): string {
    const safeId = worktreeId.replace(/[^a-z0-9-]/gi, '_');
    return path.join(this.baseDir, `${safeId}.jsonl`);
  }
}
