import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { IPCChannels } from '../../../../src/shared/ipc';

const sendMock = vi.fn();

vi.mock('electron', () => {
  const ipcHandlers = new Map<string, unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: unknown) => {
        ipcHandlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        ipcHandlers.delete(channel);
      })
    },
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] }))
    },
    BrowserWindow: class {}
  };
});

// Lazy import after mocks so the module picks up our stubs.
const { registerIpcHandlers } = await import('../../../../src/main/ipc/registerIpcHandlers');

class WorktreeServiceStub extends EventEmitter {
  resolveCanonicalWorktreeId = vi.fn((worktreeId: string) => {
    if (worktreeId === 'project-root:proj') {
      return 'wt-main';
    }
    return worktreeId;
  });

  getProjectIdForWorktree = vi.fn((worktreeId: string) => {
    if (worktreeId === 'wt-main' || worktreeId === 'project-root:proj') {
      return 'proj';
    }
    return null;
  });

  getState = vi.fn(() => ({ projects: [], worktrees: [], sessions: [] }));
  addProject = vi.fn();
  removeProject = vi.fn();
  createWorktree = vi.fn();
  removeWorktree = vi.fn();
  openWorktreeInVSCode = vi.fn();
  openWorktreeInGitGui = vi.fn();
  openWorktreeInFileManager = vi.fn();
  mergeWorktree = vi.fn();
  refreshProjectWorktrees = vi.fn();
  setCodexResumeCommand = vi.fn();
  updateCodexStatus = vi.fn(async () => {});
  getWorktreePath = vi.fn();
  dispose = vi.fn();
}

class TerminalServiceStub extends EventEmitter {
  ensure = vi.fn();
  stop = vi.fn();
  sendInput = vi.fn();
  resize = vi.fn();
  getSnapshot = vi.fn();
  getDelta = vi.fn();
  dispose = vi.fn();
  on = super.on.bind(this);
  off = super.removeListener.bind(this);
}

class CodexManagerStub extends EventEmitter {
  start = vi.fn();
  stop = vi.fn();
  sendInput = vi.fn();
  getSessions = vi.fn();
  getLog = vi.fn();
  refreshResumeFromLogs = vi.fn();
}

describe('registerIpcHandlers codex mirrors', () => {
  const windowStub = {
    webContents: {
      send: sendMock
    },
    on: vi.fn(),
    isDestroyed: () => false
  } as unknown as BrowserWindow;

  beforeEach(() => {
    sendMock.mockClear();
  });

  const createHarness = () => {
    const worktreeService = new WorktreeServiceStub();
    const gitService = { getStatus: vi.fn(), getDiff: vi.fn() };
    const codexManager = new CodexManagerStub();
    const terminalService = new TerminalServiceStub();

    registerIpcHandlers(
      windowStub,
      worktreeService as unknown as any,
      gitService as unknown as any,
      codexManager as unknown as any,
      terminalService as unknown as any
    );

    return { worktreeService, codexManager };
  };

  it('mirrors codex output events to the project root alias', () => {
    const { codexManager } = createHarness();
    sendMock.mockClear();

    codexManager.emit('codex-output', {
      sessionId: 'session-1',
      worktreeId: 'wt-main',
      chunk: 'hello world'
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(1, IPCChannels.codexOutput, {
      sessionId: 'session-1',
      worktreeId: 'wt-main',
      chunk: 'hello world'
    });
    expect(sendMock).toHaveBeenNthCalledWith(2, IPCChannels.codexOutput, {
      sessionId: 'session-1',
      worktreeId: 'project-root:proj',
      chunk: 'hello world'
    });
  });

  it('mirrors codex status events and updates canonical worktree state', () => {
    const { worktreeService, codexManager } = createHarness();
    sendMock.mockClear();
    worktreeService.updateCodexStatus.mockClear();

    codexManager.emit('codex-status', {
      sessionId: 'session-1',
      worktreeId: 'wt-main',
      status: 'running',
      error: undefined
    });

    expect(worktreeService.updateCodexStatus).toHaveBeenCalledWith('wt-main', 'running', undefined);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(1, IPCChannels.codexStatus, {
      sessionId: 'session-1',
      worktreeId: 'wt-main',
      status: 'running',
      error: undefined
    });
    expect(sendMock).toHaveBeenNthCalledWith(2, IPCChannels.codexStatus, {
      sessionId: 'session-1',
      worktreeId: 'project-root:proj',
      status: 'running',
      error: undefined
    });
  });
});
