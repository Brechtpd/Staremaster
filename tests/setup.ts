import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import type { RendererApi } from '@shared/api';
import type { AppState } from '@shared/ipc';

const emptyState: AppState = {
  projects: [],
  worktrees: [],
  sessions: [],
  preferences: { theme: 'light' }
};

class NotificationStub {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => NotificationStub.permission);
  constructor() {
    // no-op
  }
}

beforeEach(() => {
  const api: RendererApi = {
    getState: vi.fn().mockResolvedValue(emptyState),
    addProject: vi.fn().mockResolvedValue(emptyState),
    removeProject: vi.fn().mockResolvedValue(emptyState),
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
    openWorktreeInFileManager: vi.fn().mockResolvedValue(undefined),
    startCodex: vi.fn().mockResolvedValue({
      id: 'session',
      worktreeId: 'mock',
      status: 'running',
      startedAt: new Date().toISOString()
    }),
    stopCodex: vi.fn().mockResolvedValue([]),
    sendCodexInput: vi.fn().mockResolvedValue(undefined),
    onStateUpdate: vi.fn().mockReturnValue(() => {}),
    onCodexOutput: vi.fn().mockReturnValue(() => {}),
    onCodexStatus: vi.fn().mockReturnValue(() => {}),
    getGitStatus: vi.fn().mockResolvedValue({ staged: [], unstaged: [], untracked: [] }),
    getGitDiff: vi.fn().mockResolvedValue({
      filePath: '',
      staged: false,
      diff: '',
      binary: false
    }),
    getCodexLog: vi.fn().mockResolvedValue(''),
    summarizeCodexOutput: vi.fn().mockResolvedValue(''),
    refreshCodexSessionId: vi.fn().mockResolvedValue(null),
    listCodexSessions: vi.fn().mockResolvedValue([]),
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
    getTerminalSnapshot: vi.fn().mockResolvedValue({ content: '', lastEventId: 0 }),
    getTerminalDelta: vi.fn().mockResolvedValue({ chunks: [], lastEventId: 0 }),
    onTerminalOutput: vi.fn().mockReturnValue(() => {}),
    onTerminalExit: vi.fn().mockReturnValue(() => {}),
    setThemePreference: vi.fn().mockResolvedValue(emptyState)
  };

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api
  });

  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: NotificationStub
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
