import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import type { RendererApi } from '@shared/api';
import type { AppState } from '@shared/ipc';

const emptyState: AppState = {
  projects: [],
  worktrees: [],
  sessions: []
};

beforeEach(() => {
  const api: RendererApi = {
    getState: vi.fn().mockResolvedValue(emptyState),
    addProject: vi.fn().mockResolvedValue(emptyState),
    createWorktree: vi.fn().mockImplementation(async (projectId) => ({
      id: 'mock',
      projectId,
      featureName: 'mock',
      branch: 'mock',
      path: '/tmp/mock',
      createdAt: new Date().toISOString(),
      status: 'ready',
      codexStatus: 'idle'
    })),
    mergeWorktree: vi.fn().mockResolvedValue(emptyState),
    removeWorktree: vi.fn().mockResolvedValue(emptyState),
    openWorktreeInVSCode: vi.fn().mockResolvedValue(undefined),
    openWorktreeInGitGui: vi.fn().mockResolvedValue(undefined),
    startCodex: vi.fn().mockResolvedValue({
      id: 'session',
      worktreeId: 'mock',
      status: 'running',
      startedAt: new Date().toISOString()
    }),
    stopCodex: vi.fn().mockResolvedValue([]),
    sendCodexInput: vi.fn().mockResolvedValue(undefined),
    startCodexTerminal: vi.fn().mockResolvedValue({
      sessionId: 'terminal-codex',
      worktreeId: 'mock',
      shell: '/bin/bash',
      pid: 456,
      startedAt: new Date().toISOString(),
      status: 'running'
    }),
    stopCodexTerminal: vi.fn().mockResolvedValue(undefined),
    sendCodexTerminalInput: vi.fn().mockResolvedValue(undefined),
    resizeCodexTerminal: vi.fn().mockResolvedValue(undefined),
    onStateUpdate: vi.fn().mockReturnValue(() => {}),
    onCodexOutput: vi.fn().mockReturnValue(() => {}),
    onCodexStatus: vi.fn().mockReturnValue(() => {}),
    onCodexTerminalOutput: vi.fn().mockReturnValue(() => {}),
    onCodexTerminalExit: vi.fn().mockReturnValue(() => {}),
    getGitStatus: vi.fn().mockResolvedValue({ staged: [], unstaged: [], untracked: [] }),
    getGitDiff: vi.fn().mockResolvedValue({
      filePath: '',
      staged: false,
      diff: '',
      binary: false
    }),
    getCodexLog: vi.fn().mockResolvedValue(''),
    startWorktreeTerminal: vi.fn().mockResolvedValue({
      sessionId: 'terminal-1',
      worktreeId: 'mock',
      shell: '/bin/bash',
      pid: 123,
      startedAt: new Date().toISOString(),
      status: 'running'
    }),
    stopWorktreeTerminal: vi.fn().mockResolvedValue(undefined),
    sendTerminalInput: vi.fn().mockResolvedValue(undefined),
    resizeTerminal: vi.fn().mockResolvedValue(undefined),
    onTerminalOutput: vi.fn().mockReturnValue(() => {}),
    onTerminalExit: vi.fn().mockReturnValue(() => {})
  };

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
