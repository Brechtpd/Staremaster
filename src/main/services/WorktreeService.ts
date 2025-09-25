import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import simpleGit, { SimpleGit } from 'simple-git';
import { WorktreeDescriptor, AppState, CodexStatus } from '../../shared/ipc';
import { ProjectStore } from './ProjectStore';

export interface WorktreeEvents {
  'worktree-updated': (descriptor: WorktreeDescriptor) => void;
  'worktree-removed': (worktreeId: string) => void;
  'state-changed': (state: AppState) => void;
}

interface ParsedWorktree {
  path: string;
  branch: string;
}

const FEATURE_NAME_REGEX = /[^a-z0-9-_]/gi;

export class WorktreeService extends EventEmitter {
  private git: SimpleGit | null = null;
  private projectRoot: string | null = null;

  constructor(private readonly store: ProjectStore) {
    super();
  }

  async load(): Promise<void> {
    await this.store.init();
    const state = this.store.getState();
    if (state.projectRoot) {
      await this.setProjectRoot(state.projectRoot);
    } else {
      this.emit('state-changed', this.store.getState());
    }
  }

  getProjectRoot(): string | null {
    return this.projectRoot;
  }

  getState(): AppState {
    return this.store.getState();
  }

  getWorktreePath(worktreeId: string): string | null {
    const state = this.store.getState();
    const descriptor = state.worktrees.find((item) => item.id === worktreeId);
    return descriptor?.path ?? null;
  }

  async setProjectRoot(directory: string): Promise<void> {
    const resolved = await this.validateGitRepository(directory);
    this.projectRoot = resolved;
    this.git = simpleGit(resolved);
    await this.store.setProjectRoot(resolved);
    await this.refreshWorktrees();
    this.emit('state-changed', this.store.getState());
  }

  async refreshWorktrees(): Promise<void> {
    if (!this.git || !this.projectRoot) {
      return;
    }

    const listed = await this.parseExistingWorktrees();
    const state = this.store.getState();

    const knownById = new Map(state.worktrees.map((wt) => [wt.id, wt] as const));
    const seen = new Set<string>();

    for (const entry of listed) {
      const id = hashFromPath(entry.path);
      seen.add(id);
      const current = knownById.get(id);
      const descriptor: WorktreeDescriptor = {
        id,
        featureName: current?.featureName ?? deriveFeatureName(entry.path),
        branch: entry.branch,
        path: entry.path,
        createdAt: current?.createdAt ?? new Date().toISOString(),
        status: 'ready',
        codexStatus: current?.codexStatus ?? 'idle'
      };
      await this.store.upsertWorktree(descriptor);
      this.emit('worktree-updated', descriptor);
    }

    for (const item of state.worktrees) {
      if (!seen.has(item.id)) {
        await this.store.removeWorktree(item.id);
        this.emit('worktree-removed', item.id);
      }
    }

    this.emit('state-changed', this.store.getState());
  }

  async createWorktree(featureNameRaw: string): Promise<WorktreeDescriptor> {
    if (!this.git || !this.projectRoot) {
      throw new Error('Project root is not configured');
    }
    const featureName = sanitizeFeatureName(featureNameRaw);
    if (!featureName) {
      throw new Error('Feature name must contain alphanumeric characters');
    }

    const branch = featureName;
    const targetDir = path.resolve(this.projectRoot, '..', featureName);
    const id = hashFromPath(targetDir);

    const descriptor: WorktreeDescriptor = {
      id,
      featureName,
      branch,
      path: targetDir,
      createdAt: new Date().toISOString(),
      status: 'creating',
      codexStatus: 'idle'
    };

    await this.store.upsertWorktree(descriptor);
    this.emit('worktree-updated', descriptor);

    try {
      await ensureDirectoryDoesNotExist(targetDir);

      const branchSummary = await this.git.branchLocal();
      if (branchSummary.all.includes(branch)) {
        throw new Error(`Branch ${branch} already exists`);
      }

      await this.git.raw(['worktree', 'add', targetDir, '-b', branch]);
      descriptor.status = 'ready';
      await this.store.upsertWorktree(descriptor);
      this.emit('worktree-updated', descriptor);
    } catch (error) {
      descriptor.status = 'error';
      descriptor.lastError = (error as Error).message;
      await this.store.upsertWorktree(descriptor);
      this.emit('worktree-updated', descriptor);
      throw error;
    }

    await this.refreshWorktrees();
    return descriptor;
  }

  async removeWorktree(worktreeId: string): Promise<void> {
    if (!this.git || !this.projectRoot) {
      throw new Error('Project root is not configured');
    }

    const state = this.store.getState();
    const descriptor = state.worktrees.find((item) => item.id === worktreeId);

    if (!descriptor) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }

    descriptor.status = 'removing';
    await this.store.upsertWorktree(descriptor);
    this.emit('worktree-updated', descriptor);

    try {
      await this.git.raw(['worktree', 'remove', descriptor.path]);
      await this.store.removeWorktree(descriptor.id);
      this.emit('worktree-removed', descriptor.id);
    } catch (error) {
      descriptor.status = 'error';
      descriptor.lastError = (error as Error).message;
      await this.store.upsertWorktree(descriptor);
      this.emit('worktree-updated', descriptor);
      throw error;
    }

    this.emit('state-changed', this.store.getState());
  }

  async updateCodexStatus(worktreeId: string, status: CodexStatus, error?: string): Promise<void> {
    await this.store.patchWorktree(worktreeId, {
      codexStatus: status,
      lastError: error
    });
    this.emit('state-changed', this.store.getState());
  }

  private async validateGitRepository(directory: string): Promise<string> {
    const resolved = path.resolve(directory);
    const gitDir = path.join(resolved, '.git');
    try {
      await fs.access(gitDir);
    } catch {
      throw new Error(`${resolved} is not a git repository`);
    }
    return resolved;
  }

  private async parseExistingWorktrees(): Promise<ParsedWorktree[]> {
    if (!this.git) {
      return [];
    }

    const output = await this.git.raw(['worktree', 'list', '--porcelain']);
    const entries = output.split(/\n(?=worktree )/g).filter(Boolean);

    return entries.map((entry) => {
      const lines = entry.split('\n');
      const worktreeLine = lines.find((line) => line.startsWith('worktree '));
      const branchLine = lines.find((line) => line.startsWith('branch '));

      const worktreePath = worktreeLine?.replace('worktree ', '').trim();
      const branchRef = branchLine?.replace('branch ', '').trim();
      const branch = branchRef?.replace('refs/heads/', '') ?? 'HEAD';

      if (!worktreePath) {
        throw new Error(`Failed to parse worktree entry: ${entry}`);
      }

      return {
        path: worktreePath,
        branch
      };
    });
  }
}

const sanitizeFeatureName = (input: string): string => {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(FEATURE_NAME_REGEX, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

const hashFromPath = (input: string): string => {
  return createHash('sha1').update(path.resolve(input)).digest('hex');
};

const deriveFeatureName = (worktreePath: string): string => {
  return path.basename(worktreePath).replace(/[^a-z0-9-_]/gi, '');
};

const ensureDirectoryDoesNotExist = async (targetDir: string): Promise<void> => {
  try {
    await fs.access(targetDir);
  } catch {
    return;
  }
  throw new Error(`Target directory already exists: ${targetDir}`);
};
