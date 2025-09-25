import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import type { RendererApi } from '@shared/api';
import type { AppState } from '@shared/ipc';

const emptyState: AppState = {
  projectRoot: null,
  worktrees: [],
  sessions: []
};

beforeEach(() => {
  const api: RendererApi = {
    getState: vi.fn().mockResolvedValue(emptyState),
    selectProjectRoot: vi.fn().mockResolvedValue(emptyState),
    createWorktree: vi.fn().mockResolvedValue({
      id: 'mock',
      featureName: 'mock',
      branch: 'mock',
      path: '/tmp/mock',
      createdAt: new Date().toISOString(),
      status: 'ready',
      codexStatus: 'idle'
    }),
    removeWorktree: vi.fn().mockResolvedValue(emptyState),
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
    onCodexStatus: vi.fn().mockReturnValue(() => {})
  };

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
