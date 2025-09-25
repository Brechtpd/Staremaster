import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import simpleGit, { SimpleGit } from 'simple-git';
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
        codexStatus: current?.codexStatus ?? 'idle'
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

  async removeWorktree(worktreeId: string): Promise<void> {
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
