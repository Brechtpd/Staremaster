import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import simpleGit, { SimpleGit } from 'simple-git';
import { spawn } from 'node:child_process';
import { WorktreeDescriptor, AppState, CodexStatus, ProjectDescriptor } from '../../shared/ipc';
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

interface ProjectContext {
  id: string;
  root: string;
  git: SimpleGit;
}

const FEATURE_NAME_REGEX = /[^a-z0-9-_]/gi;

export class WorktreeService extends EventEmitter {
  private readonly projects = new Map<string, ProjectContext>();

  constructor(private readonly store: ProjectStore) {
    super();
  }

  async load(): Promise<void> {
    await this.store.init();
    const state = this.store.getState();
    for (const project of state.projects) {
      try {
        await this.ensureProjectContext(project.id, project.root);
        await this.refreshProjectWorktrees(project.id);
      } catch (error) {
        console.error('[worktree] failed to load project', project.root, error);
      }
    }
    this.emit('state-changed', this.store.getState());
  }

  getState(): AppState {
    return this.store.getState();
  }

  getWorktreePath(worktreeId: string): string | null {
    const state = this.store.getState();
    const descriptor = state.worktrees.find((item) => item.id === worktreeId);
    return descriptor?.path ?? null;
  }

  async addProject(directory: string): Promise<void> {
    const resolved = await this.validateGitRepository(directory);
    const id = hashFromPath(resolved);
    await this.ensureProjectContext(id, resolved);
    const state = this.store.getState();
    const current = state.projects.find((item) => item.id === id);
    const descriptor: ProjectDescriptor = {
      id,
      root: resolved,
      name: path.basename(resolved),
      createdAt: current?.createdAt ?? new Date().toISOString()
    };
    await this.store.upsertProject(descriptor);
    await this.refreshProjectWorktrees(id);
    this.emit('state-changed', this.store.getState());
  }

  async refreshProjectWorktrees(projectId: string): Promise<void> {
    const context = await this.ensureProjectContextFromStore(projectId);
    const listed = await this.parseExistingWorktrees(context.git);
    const state = this.store.getState();

    const existingForProject = state.worktrees.filter((item) => item.projectId === projectId);
    const knownById = new Map(existingForProject.map((wt) => [wt.id, wt] as const));
    const seen = new Set<string>();

    for (const entry of listed) {
      const id = hashFromPath(entry.path);
      seen.add(id);
      const current = knownById.get(id);
      const descriptor: WorktreeDescriptor = {
        id,
        projectId,
        featureName: current?.featureName ?? deriveFeatureName(entry.path),
        branch: entry.branch,
        path: entry.path,
        createdAt: current?.createdAt ?? new Date().toISOString(),
        status: 'ready',
        codexStatus: current?.codexStatus ?? 'idle',
        lastError: current?.lastError
      };
      await this.store.upsertWorktree(descriptor);
      this.emit('worktree-updated', descriptor);
    }

    for (const item of existingForProject) {
      if (!seen.has(item.id)) {
        await this.store.removeWorktree(item.id);
        this.emit('worktree-removed', item.id);
      }
    }

    this.emit('state-changed', this.store.getState());
  }

  async createWorktree(projectId: string, featureNameRaw: string): Promise<WorktreeDescriptor> {
    const context = await this.ensureProjectContextFromStore(projectId);
    const featureName = sanitizeFeatureName(featureNameRaw);
    if (!featureName) {
      throw new Error('Feature name must contain alphanumeric characters');
    }

    const branch = featureName;
    const targetDir = path.resolve(context.root, '..', featureName);
    const id = hashFromPath(targetDir);

    const descriptor: WorktreeDescriptor = {
      id,
      projectId,
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

      const branchSummary = await context.git.branchLocal();
      if (branchSummary.all.includes(branch)) {
        throw new Error(`Branch ${branch} already exists`);
      }

      await context.git.raw(['worktree', 'add', targetDir, '-b', branch]);
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

    await this.refreshProjectWorktrees(projectId);
    return descriptor;
  }

  async removeWorktree(worktreeId: string, options?: { deleteFolder?: boolean }): Promise<void> {
    const state = this.store.getState();
    const descriptor = state.worktrees.find((item) => item.id === worktreeId);

    if (!descriptor) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }

    const context = await this.ensureProjectContextFromStore(descriptor.projectId);

    descriptor.status = 'removing';
    await this.store.upsertWorktree(descriptor);
    this.emit('worktree-updated', descriptor);

    try {
      await context.git.raw(['worktree', 'remove', descriptor.path]);
      if (options?.deleteFolder) {
        try {
          await fs.rm(descriptor.path, { recursive: true, force: true });
        } catch (removeError) {
          console.warn('[worktree] failed to delete directory', descriptor.path, removeError);
        }
      }
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

  async mergeWorktree(worktreeId: string): Promise<AppState> {
    const state = this.store.getState();
    const descriptor = state.worktrees.find((item) => item.id === worktreeId);

    if (!descriptor) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }

    const context = await this.ensureProjectContextFromStore(descriptor.projectId);
    const git = context.git;

    const targetBranch = await this.resolvePrimaryBranch(git);
    if (!targetBranch) {
      throw new Error('Unable to determine the main branch to merge into');
    }

    if (descriptor.branch === targetBranch) {
      throw new Error('Cannot merge the main branch into itself');
    }

    descriptor.status = 'merging';
    descriptor.lastError = undefined;
    await this.store.upsertWorktree(descriptor);
    this.emit('worktree-updated', descriptor);

    const branchSummary = await git.branch();
    const previousBranch = branchSummary.current;

    try {
      await git.checkout(targetBranch);
      await git.raw(['merge', '--no-ff', descriptor.branch]);
      descriptor.status = 'ready';
      descriptor.lastError = undefined;
      await this.store.upsertWorktree(descriptor);
      this.emit('worktree-updated', descriptor);
    } catch (error) {
      descriptor.status = 'error';
      descriptor.lastError = (error as Error).message;
      await this.store.upsertWorktree(descriptor);
      this.emit('worktree-updated', descriptor);
      throw error;
    } finally {
      if (previousBranch && previousBranch !== targetBranch) {
        try {
          await git.checkout(previousBranch);
        } catch (restoreError) {
          console.warn('[worktree] failed to restore branch after merge', restoreError);
        }
      }
    }

    const nextState = this.store.getState();
    this.emit('state-changed', nextState);
    return nextState;
  }

  async updateCodexStatus(worktreeId: string, status: CodexStatus, error?: string): Promise<void> {
    await this.store.patchWorktree(worktreeId, {
      codexStatus: status,
      lastError: error
    });
    this.emit('state-changed', this.store.getState());
  }

  async openWorktreeInVSCode(worktreeId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(worktreeId);
    if (!worktreePath) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }
    const command = process.platform === 'win32' ? 'code.cmd' : 'code';
    await this.launchExternal(command, [worktreePath], worktreePath, 'VS Code');
  }

  async openWorktreeInGitGui(worktreeId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(worktreeId);
    if (!worktreePath) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }
    await this.launchExternal('git', ['gui'], worktreePath, 'Git GUI');
  }

  private async launchExternal(
    command: string,
    args: string[],
    cwd: string,
    label: string
  ): Promise<void> {
    await fs.access(cwd);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: 'ignore',
        detached: true
      });
      child.on('error', (error) => {
        reject(new Error(`Failed to launch ${label}: ${(error as Error).message}`));
      });
      child.unref();
      resolve();
    });
  }

  private async ensureProjectContext(projectId: string, root: string): Promise<ProjectContext> {
    const resolved = await this.validateGitRepository(root);
    const existing = this.projects.get(projectId);
    if (existing && path.resolve(existing.root) === resolved) {
      return existing;
    }
    const context: ProjectContext = {
      id: projectId,
      root: resolved,
      git: simpleGit(resolved)
    };
    this.projects.set(projectId, context);
    return context;
  }

  private async ensureProjectContextFromStore(projectId: string): Promise<ProjectContext> {
    const state = this.store.getState();
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error(`Unknown project ${projectId}`);
    }
    return this.ensureProjectContext(project.id, project.root);
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

  private async parseExistingWorktrees(git: SimpleGit): Promise<ParsedWorktree[]> {
    const output = await git.raw(['worktree', 'list', '--porcelain']);
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

  private async resolvePrimaryBranch(git: SimpleGit): Promise<string | null> {
    try {
      const summary = await git.branch();
      if (summary.all.some((branch) => branch === 'main' || branch.endsWith('/main'))) {
        return 'main';
      }
      if (summary.all.some((branch) => branch === 'master' || branch.endsWith('/master'))) {
        return 'master';
      }
      return summary.current ?? null;
    } catch (error) {
      console.warn('[worktree] failed to resolve primary branch', error);
      return null;
    }
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
