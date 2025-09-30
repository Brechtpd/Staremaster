import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import simpleGit, { SimpleGit, StatusResult } from 'simple-git';
import { spawn } from 'node:child_process';
import {
  WorktreeDescriptor,
  AppState,
  CodexStatus,
  ProjectDescriptor,
  ThemePreference,
  WorktreeOperationLogEntry
} from '../../shared/ipc';
import { ProjectStore } from './ProjectStore';
import { WorktreeAuditLog } from './WorktreeAuditLog';

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

  constructor(private readonly store: ProjectStore, private readonly auditLog: WorktreeAuditLog) {
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

  async setThemePreference(theme: ThemePreference): Promise<AppState> {
    await this.store.setThemePreference(theme);
    const updated = this.store.getState();
    this.emit('state-changed', updated);
    return updated;
  }

  getWorktreePath(worktreeId: string): string | null {
    const state = this.store.getState();
    if (worktreeId.startsWith('project-root:')) {
      const projectId = worktreeId.slice('project-root:'.length);
      const project = state.projects.find((item) => item.id === projectId);
      return project?.root ?? null;
    }
    const descriptor = state.worktrees.find((item) => item.id === worktreeId);
    return descriptor?.path ?? null;
  }

  resolveCanonicalWorktreeId(worktreeId: string): string | null {
    if (!worktreeId.startsWith('project-root:')) {
      return worktreeId;
    }
    const projectId = worktreeId.slice('project-root:'.length);
    const state = this.store.getState();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) {
      return null;
    }
    const preferred = project.defaultWorktreeId;
    if (preferred && state.worktrees.some((w) => w.id === preferred)) {
      return preferred;
    }
    const first = state.worktrees.find((w) => w.projectId === projectId);
    return first ? first.id : null;
  }

  getProjectIdForWorktree(worktreeId: string): string | null {
    if (worktreeId.startsWith('project-root:')) {
      return worktreeId.slice('project-root:'.length);
    }
    const state = this.store.getState();
    const wt = state.worktrees.find((w) => w.id === worktreeId);
    return wt ? wt.projectId : null;
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

    const latestState = this.store.getState();
    const project = latestState.projects.find((item) => item.id === projectId);
    const existingDefaultId = project?.defaultWorktreeId;
    const candidates = latestState.worktrees.filter((item) => item.projectId === projectId);
    const existingDefaultStillValid = Boolean(existingDefaultId && candidates.some((item) => item.id === existingDefaultId));
    if (!existingDefaultStillValid) {
      const newest = candidates
        .slice()
        .sort((a, b) => Date.parse(b.createdAt ?? '0') - Date.parse(a.createdAt ?? '0'))[0];
      const nextDefault = newest?.id;
      if ((nextDefault ?? undefined) !== (existingDefaultId ?? undefined)) {
        await this.store.patchProject(projectId, {
          defaultWorktreeId: nextDefault ?? undefined
        });
      }
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

  async removeProject(projectId: string): Promise<void> {
    const state = this.store.getState();
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error(`Unknown project ${projectId}`);
    }

    const removedWorktreeIds = state.worktrees.filter((item) => item.projectId === projectId).map((item) => item.id);

    this.projects.delete(projectId);
    await this.store.removeProject(projectId);

    removedWorktreeIds.forEach((worktreeId) => {
      this.emit('worktree-removed', worktreeId);
    });

    this.emit('state-changed', this.store.getState());
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

  async pullWorktree(worktreeId: string): Promise<AppState> {
    if (worktreeId.startsWith('project-root:')) {
      throw new Error('Select a specific worktree before pulling changes from the main branch.');
    }

    const state = this.store.getState();
    const descriptor = state.worktrees.find((item) => item.id === worktreeId);

    if (!descriptor) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }

    if (descriptor.status === 'pulling' || descriptor.status === 'merging' || descriptor.status === 'removing') {
      throw new Error('This worktree is busy with another operation. Try again once it returns to ready state.');
    }

    const context = await this.ensureProjectContextFromStore(descriptor.projectId);
    const worktreeGit = this.createWorktreeGit(descriptor.path);
    const actor = this.resolveActor();
    const logBase: Omit<WorktreeOperationLogEntry, 'outcome' | 'timestamp'> = {
      worktreeId: descriptor.id,
      actor,
      action: 'pull'
    };

    const status = await worktreeGit.status();
    if (!isCleanStatus(status)) {
      const detail = describeDirtyStatus(status);
      await this.auditLog.append({ ...logBase, timestamp: new Date().toISOString(), outcome: 'blocked', detail });
      descriptor.status = 'ready';
      descriptor.lastError = detail;
      await this.store.upsertWorktree(descriptor);
      this.emit('worktree-updated', descriptor);
      throw new Error(detail);
    }

    const primaryBranch = await this.resolvePrimaryBranch(context.git);
    if (!primaryBranch) {
      const detail = 'Unable to determine the main branch to pull from.';
      await this.auditLog.append({ ...logBase, timestamp: new Date().toISOString(), outcome: 'blocked', detail });
      descriptor.lastError = detail;
      await this.store.upsertWorktree(descriptor);
      this.emit('worktree-updated', descriptor);
      throw new Error(detail);
    }

    descriptor.status = 'pulling';
    descriptor.lastError = undefined;
    await this.store.upsertWorktree(descriptor);
    this.emit('worktree-updated', descriptor);

    const remoteBranch = `origin/${primaryBranch}`;
    let failureMessage: string | undefined;

    try {
      await worktreeGit.fetch('origin', primaryBranch);
      await worktreeGit.raw(['merge', '--no-edit', remoteBranch]);
      await this.auditLog.append({
        ...logBase,
        timestamp: new Date().toISOString(),
        outcome: 'success',
        detail: `Merged ${remoteBranch}`
      });
    } catch (error) {
      failureMessage = (error as Error).message;
      await this.auditLog.append({
        ...logBase,
        timestamp: new Date().toISOString(),
        outcome: 'error',
        detail: failureMessage
      });
      await this.abortMerge(worktreeGit);
      descriptor.lastError = failureMessage;
      throw error;
    } finally {
      descriptor.status = 'ready';
      descriptor.lastError = failureMessage;
      await this.store.upsertWorktree(descriptor);
      this.emit('worktree-updated', descriptor);
    }

    await this.refreshProjectWorktrees(descriptor.projectId);
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

  async openWorktreeInFileManager(worktreeId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(worktreeId);
    if (!worktreePath) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }

    let command: string;
    let args: string[] = [];

    if (process.platform === 'win32') {
      command = 'explorer.exe';
      args = [worktreePath];
    } else if (process.platform === 'darwin') {
      command = 'open';
      args = [worktreePath];
    } else {
      command = 'xdg-open';
      args = [worktreePath];
    }

    await this.launchExternal(command, args, worktreePath, 'file manager');
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

  private createWorktreeGit(worktreePath: string): SimpleGit {
    return simpleGit(worktreePath);
  }

  private resolveActor(): string {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }

  private async abortMerge(git: SimpleGit): Promise<void> {
    try {
      await git.raw(['merge', '--abort']);
    } catch (error) {
      if ((error as Error).message.includes('No merge to abort')) {
        return;
      }
      console.warn('[worktree] merge abort failed', error);
    }
  }
}

const isCleanStatus = (status: StatusResult): boolean => {
  return status.files.length === 0 && status.not_added.length === 0 && status.conflicted.length === 0;
};

const describeDirtyStatus = (status: StatusResult): string => {
  const stagedCount = status.files.filter((file) => file.index !== ' ').length;
  const unstagedCount = status.files.filter((file) => file.working_tree !== ' ').length;
  const untrackedCount = status.not_added.length;
  const conflictedCount = status.conflicted.length;

  const parts: string[] = [];
  if (stagedCount > 0) {
    parts.push(`${stagedCount} staged`);
  }
  if (unstagedCount > 0) {
    parts.push(`${unstagedCount} unstaged`);
  }
  if (untrackedCount > 0) {
    parts.push(`${untrackedCount} untracked`);
  }
  if (conflictedCount > 0) {
    parts.push(`${conflictedCount} conflicted`);
  }

  const detail = parts.length > 0 ? parts.join(', ') : 'pending changes';
  return `Pull requires a clean worktree. Resolve ${detail} before trying again.`;
};

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
