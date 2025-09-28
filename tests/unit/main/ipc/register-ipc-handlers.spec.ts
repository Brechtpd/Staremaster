import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { WorktreeService } from '../../../../src/main/services/WorktreeService';
import type { GitService } from '../../../../src/main/services/GitService';
import type { CodexSessionManager } from '../../../../src/main/services/CodexSessionManager';
import type { TerminalService } from '../../../../src/main/services/TerminalService';
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

const { ipcMain } = await import('electron');

// Lazy import after mocks so the module picks up our stubs.
const { registerIpcHandlers } = await import('../../../../src/main/ipc/registerIpcHandlers');

class WorktreeServiceStub extends EventEmitter {
  resolveCanonicalWorktreeId = vi.fn((worktreeId: string) => {
    if (worktreeId === 'project-root:proj') {
      return 'wt-main';
    }
    if (worktreeId === 'project-root:missing') {
      return null;
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
  refreshCodexSessionId = vi.fn();
  listCodexSessionCandidates = vi.fn();
}

describe('registerIpcHandlers codex routing', () => {
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
      worktreeService as unknown as WorktreeService,
      gitService as unknown as GitService,
      codexManager as unknown as CodexSessionManager,
      terminalService as unknown as TerminalService
    );

    return { worktreeService, codexManager };
  };

  it('forwards codex output events only for canonical worktrees', () => {
    const { codexManager } = createHarness();
    sendMock.mockClear();

    codexManager.emit('codex-output', {
      sessionId: 'session-1',
      worktreeId: 'wt-main',
      chunk: 'hello world'
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenNthCalledWith(1, IPCChannels.codexOutput, {
      sessionId: 'session-1',
      worktreeId: 'wt-main',
      chunk: 'hello world'
    });
  });

  it('forwards codex status events and updates canonical worktree state', () => {
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
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenNthCalledWith(1, IPCChannels.codexStatus, {
      sessionId: 'session-1',
      worktreeId: 'wt-main',
      status: 'running',
      error: undefined
    });
  });

  it('refreshes session id using the canonical worktree id', async () => {
    const { codexManager } = createHarness();
    const handleMock = ipcMain.handle as unknown as Mock;
    const refreshHandler = handleMock.mock.calls.find(([channel]) => channel === IPCChannels.codexRefreshSessionId)?.[1] as
      | ((event: unknown, payload: { worktreeId: string; sessionId?: string | null }) => Promise<string | null>)
      | undefined;
    expect(refreshHandler).toBeDefined();
    codexManager.refreshCodexSessionId.mockResolvedValue('session-from-fs');
    const result = await refreshHandler?.({}, { worktreeId: 'project-root:proj' });
    expect(codexManager.refreshCodexSessionId).toHaveBeenCalledWith('wt-main', undefined);
    expect(result).toBe('session-from-fs');
  });

  it('rejects session refresh when no canonical worktree exists', async () => {
    const { codexManager } = createHarness();
    const handleMock = ipcMain.handle as unknown as Mock;
    const refreshHandler = handleMock.mock.calls.find(([channel]) => channel === IPCChannels.codexRefreshSessionId)?.[1] as
      | ((event: unknown, payload: { worktreeId: string; sessionId?: string | null }) => Promise<string | null>)
      | undefined;
    await expect(refreshHandler?.({}, { worktreeId: 'project-root:missing' })).rejects.toThrow(/No canonical worktree/);
    expect(codexManager.refreshCodexSessionId).not.toHaveBeenCalled();
  });

  it('lists Codex sessions via the canonical worktree id', async () => {
    const { codexManager } = createHarness();
    const handleMock = ipcMain.handle as unknown as Mock;
    const listHandler = handleMock.mock.calls.find(([channel]) => channel === IPCChannels.codexListSessions)?.[1] as
      | ((event: unknown, payload: { worktreeId: string }) => Promise<Array<{ id: string; mtimeMs: number }>>)
      | undefined;
    expect(listHandler).toBeDefined();
    codexManager.listCodexSessionCandidates.mockResolvedValue([{ id: 'abc', mtimeMs: 1 }]);
    const result = await listHandler?.({}, { worktreeId: 'project-root:proj' });
    expect(codexManager.listCodexSessionCandidates).toHaveBeenCalledWith('wt-main');
    expect(result).toEqual([{ id: 'abc', mtimeMs: 1 }]);
  });
});
