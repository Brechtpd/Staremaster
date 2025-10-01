import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import type { StatusResult, BranchSummary } from 'simple-git';
import { ProjectStore } from '../../../../src/main/services/ProjectStore';
import { WorktreeService } from '../../../../src/main/services/WorktreeService';
import { WorktreeAuditLog } from '../../../../src/main/services/WorktreeAuditLog';
import type { WorktreeDescriptor } from '../../../../src/shared/ipc';

const createStatus = (overrides: Partial<StatusResult>): StatusResult => ({
  not_added: [],
  conflicted: [],
  created: [],
  deleted: [],
  modified: [],
  renamed: [],
  staged: [],
  ahead: 0,
  behind: 0,
  current: 'feature/integration',
  tracking: null,
  files: [],
  ...overrides
});

const cleanStatus = createStatus({});
const dirtyStatus = createStatus({
  files: [
    { path: 'app.ts', index: 'M', working_tree: ' ' },
    { path: 'readme.md', index: ' ', working_tree: 'M' }
  ],
  staged: ['app.ts']
});

const branchSummary: BranchSummary = {
  current: 'feature/integration',
  all: ['main', 'feature/integration'],
  branches: {
    main: {
      name: 'main',
      commit: 'abc',
      label: 'main'
    },
    'feature/integration': {
      name: 'feature/integration',
      commit: 'def',
      label: 'feature/integration'
    }
  },
  detached: false
};

type SimpleGitStub = {
  status: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  raw: ReturnType<typeof vi.fn>;
  branch: ReturnType<typeof vi.fn>;
};

const createGitStub = (): SimpleGitStub => ({
  status: vi.fn(),
  fetch: vi.fn(),
  raw: vi.fn(),
  branch: vi.fn()
});

const projectGitStub = createGitStub();
const worktreeGitStub = createGitStub();

vi.mock('simple-git', () => {
  const factory = (baseDir?: string) => {
    if (baseDir?.includes('worktree')) {
      return worktreeGitStub;
    }
    return projectGitStub;
  };
  return {
    __esModule: true,
    default: factory,
    simpleGit: factory
  };
});

describe('WorktreeService.pullWorktree', () => {
  let store: ProjectStore;
  let auditLog: WorktreeAuditLog;
  let service: WorktreeService;
  let worktree: WorktreeDescriptor;
  let tempDir: string;
  let resolvePrimaryBranchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    projectGitStub.status.mockReset();
    projectGitStub.fetch.mockReset();
    projectGitStub.raw.mockReset();
    projectGitStub.branch.mockReset();
    worktreeGitStub.status.mockReset();
    worktreeGitStub.fetch.mockReset();
    worktreeGitStub.raw.mockReset();
    worktreeGitStub.branch.mockReset();

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'worktree-service-unit-'));
    store = new ProjectStore(tempDir);
    await store.init();

    const projectId = 'project-1';
    await mkdir(path.join(tempDir, 'project', '.git'), { recursive: true });
    await mkdir(path.join(tempDir, 'worktree'), { recursive: true });
    await store.upsertProject({
      id: projectId,
      root: path.join(tempDir, 'project'),
      name: 'Project',
      createdAt: new Date().toISOString()
    });

    worktree = {
      id: 'worktree-1',
      projectId,
      featureName: 'feature/integration',
      branch: 'feature/integration',
      path: path.join(tempDir, 'worktree'),
      createdAt: new Date().toISOString(),
      status: 'ready',
      codexStatus: 'idle'
    };
    await store.upsertWorktree(worktree);

    projectGitStub.raw.mockResolvedValue(
      `worktree ${worktree.path}\nbranch refs/heads/${worktree.branch}\n`
    );
    projectGitStub.branch.mockResolvedValue(branchSummary);
    worktreeGitStub.status.mockResolvedValue(cleanStatus);
    worktreeGitStub.fetch.mockResolvedValue(undefined);
    worktreeGitStub.raw.mockResolvedValue(undefined);

    auditLog = new WorktreeAuditLog(path.join(tempDir, 'logs'));
    service = new WorktreeService(store, auditLog);
    resolvePrimaryBranchSpy = vi.spyOn(
      service as unknown as { resolvePrimaryBranch: (git: unknown) => Promise<string | null> },
      'resolvePrimaryBranch'
    );
    resolvePrimaryBranchSpy.mockResolvedValue('main');
    vi.spyOn(service, 'refreshProjectWorktrees').mockResolvedValue(undefined);
  });

  it('fetches and merges origin/main when the worktree is clean', async () => {
    projectGitStub.branch.mockResolvedValue(branchSummary);
    worktreeGitStub.status.mockResolvedValueOnce(cleanStatus);
    worktreeGitStub.fetch.mockResolvedValue(undefined);
    worktreeGitStub.raw.mockResolvedValue(undefined);

    await service.pullWorktree(worktree.id);

    expect(worktreeGitStub.fetch).toHaveBeenCalledWith('origin', 'main');
    expect(worktreeGitStub.raw).toHaveBeenCalledWith(['merge', '--no-edit', 'origin/main']);

    const state = store.getState();
    const descriptor = state.worktrees.find((item) => item.id === worktree.id);
    expect(descriptor?.status).toBe('ready');
    expect(descriptor?.lastError).toBeUndefined();

    const logPath = auditLog.resolvePath(worktree.id);
    const logContent = await readFile(logPath, 'utf8');
    expect(logContent).toContain('"outcome":"success"');
  });

  it('blocks the pull when git status is dirty', async () => {
    projectGitStub.branch.mockResolvedValue(branchSummary);
    worktreeGitStub.status.mockResolvedValueOnce(dirtyStatus);

    await expect(service.pullWorktree(worktree.id)).rejects.toThrow(/Pull requires a clean worktree/);
    expect(worktreeGitStub.fetch).not.toHaveBeenCalled();

    const state = store.getState();
    const descriptor = state.worktrees.find((item) => item.id === worktree.id);
    expect(descriptor?.status).toBe('ready');
    expect(descriptor?.lastError).toMatch(/Pull requires a clean worktree/);

    const logPath = auditLog.resolvePath(worktree.id);
    const logContent = await readFile(logPath, 'utf8');
    expect(logContent).toContain('"outcome":"blocked"');
  });
});
