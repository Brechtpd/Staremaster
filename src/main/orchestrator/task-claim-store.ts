import { promises as fs } from 'node:fs';
import type { TaskRecord, TaskStatus, WorkerRole } from '@shared/orchestrator';
import { TaskStore, type LoadTaskOptions, type TaskEntry } from './task-store';

export interface ClaimedTask {
  entry: TaskEntry;
  options: LoadTaskOptions;
  role: WorkerRole;
  lockPath: string;
}

interface ClaimStats {
  claimsSucceeded: number;
  claimConflicts: number;
  releases: number;
  failures: number;
}

const LOCK_SUFFIX = '.lock';

export class TaskClaimStore {
  private readonly stats: ClaimStats = {
    claimsSucceeded: 0,
    claimConflicts: 0,
    releases: 0,
    failures: 0
  };

  constructor(private readonly taskStore: TaskStore) {}

  async claimNext(options: LoadTaskOptions & { role: WorkerRole }): Promise<ClaimedTask | null> {
    const entries = await this.taskStore.readTaskEntries(options);
    const recordById = new Map(entries.map((entry) => [entry.record.id, entry.record]));
    const candidates = entries
      .filter((entry) =>
        entry.record.role === options.role &&
        entry.record.status === 'ready' &&
        this.dependenciesSatisfied(entry.record.dependsOn, recordById)
      )
      .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));

    for (const entry of candidates) {
      const lockPath = this.buildLockPath(entry.filePath);
      const locked = await this.tryCreateLock(lockPath);
      if (!locked) {
        this.stats.claimConflicts += 1;
        continue;
      }
      try {
        const payload = await this.readTaskPayload(entry.filePath);
        if (!payload || payload.status !== 'ready') {
          await this.safeRemoveLock(lockPath);
          continue;
        }
        payload.status = 'in_progress';
        payload.last_claimed_by = options.role;
        payload.updated_at = new Date().toISOString();
        await this.writeTaskPayload(entry.filePath, payload);
        const refreshed = await this.readEntryByPath(options, entry.filePath);
        if (!refreshed) {
          await this.safeRemoveLock(lockPath);
          continue;
        }
        this.stats.claimsSucceeded += 1;
        return {
          entry: refreshed,
          options,
          role: options.role,
          lockPath
        };
      } catch (error) {
        this.stats.failures += 1;
        await this.safeRemoveLock(lockPath);
        console.warn('[orchestrator] claim failed', {
          filePath: entry.filePath,
          message: (error as Error).message
        });
      }
    }

    return null;
  }

  private dependenciesSatisfied(dependsOn: string[], records: Map<string, TaskRecord>): boolean {
    if (!dependsOn || dependsOn.length === 0) {
      return true;
    }
    return dependsOn.every((id) => {
      const record = records.get(id);
      if (!record) {
        return false;
      }
      return record.status === 'done' || record.status === 'approved';
    });
  }

  async markDone(claim: ClaimedTask, updates: Partial<Omit<TaskRecord, 'id'>> & { status?: TaskStatus }): Promise<TaskRecord | null> {
    return await this.finalize(claim, { status: 'done', ...updates });
  }

  async markBlocked(claim: ClaimedTask, message: string): Promise<TaskRecord | null> {
    return await this.finalize(claim, {
      status: 'blocked',
      summary: message
    });
  }

  async release(claim: ClaimedTask): Promise<void> {
    await this.safeRemoveLock(claim.lockPath);
    this.stats.releases += 1;
  }

  getStats(): ClaimStats {
    return { ...this.stats };
  }

  private async finalize(
    claim: ClaimedTask,
    updates: Partial<Omit<TaskRecord, 'id'>> & { status?: TaskStatus }
  ): Promise<TaskRecord | null> {
    try {
      const payload = await this.readTaskPayload(claim.entry.filePath);
      if (!payload) {
        await this.release(claim);
        return null;
      }
      // Ensure we still own the task
      if (payload.status !== 'in_progress' || payload.last_claimed_by !== claim.role) {
        await this.release(claim);
        return null;
      }
      if (updates.status) {
        payload.status = updates.status;
      }
      if (updates.summary) {
        payload.summary = updates.summary;
      }
      if (updates.approvalsRequired != null) {
        payload.approvals_required = updates.approvalsRequired;
      }
      if (updates.approvals) {
        payload.approvals = updates.approvals;
      }
      if (updates.artifacts) {
        payload.artifacts = updates.artifacts;
      }
      if (updates.assignee) {
        payload.assignee = updates.assignee;
      }
      if (updates.dependsOn) {
        payload.depends_on = updates.dependsOn;
      }
      if (updates.title) {
        payload.title = updates.title;
      }
      if (updates.prompt) {
        payload.prompt = updates.prompt;
      }
      payload.updated_at = new Date().toISOString();
      await this.writeTaskPayload(claim.entry.filePath, payload);
      await this.release(claim);
      const refreshed = await this.readEntryByPath(claim.options, claim.entry.filePath);
      return refreshed?.record ?? null;
    } catch (error) {
      this.stats.failures += 1;
      await this.release(claim);
      console.warn('[orchestrator] finalize failed', {
        filePath: claim.entry.filePath,
        message: (error as Error).message
      });
      return null;
    }
  }

  private buildLockPath(filePath: string): string {
    return `${filePath}${LOCK_SUFFIX}`;
  }

  private async tryCreateLock(lockPath: string): Promise<boolean> {
    try {
      await fs.mkdir(lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }

  private async safeRemoveLock(lockPath: string): Promise<void> {
    try {
      await fs.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      console.warn('[orchestrator] failed to remove lock', { lockPath, error });
    }
  }

  private async readEntryByPath(options: LoadTaskOptions, filePath: string): Promise<TaskEntry | null> {
    const entries = await this.taskStore.readTaskEntries(options);
    return entries.find((entry) => entry.filePath === filePath) ?? null;
  }

  private async readTaskPayload(filePath: string): Promise<Record<string, unknown> | null> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      console.warn('[orchestrator] failed to read task payload', { filePath, error });
      return null;
    }
  }

  private async writeTaskPayload(filePath: string, payload: Record<string, unknown>): Promise<void> {
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    await fs.writeFile(filePath, serialized, 'utf8');
  }
}
