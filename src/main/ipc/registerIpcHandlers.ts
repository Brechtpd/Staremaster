import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  IPCChannels,
  AppState,
  GitStatusRequest,
  GitDiffRequest,
  CodexLogRequest,
  TerminalResizeRequest,
  TerminalOutputPayload,
  TerminalExitPayload
} from '../../shared/ipc';
import { WorktreeService } from '../services/WorktreeService';
import { CodexSessionManager } from '../services/CodexSessionManager';
import { GitService } from '../services/GitService';
import { TerminalService } from '../services/TerminalService';

export const registerIpcHandlers = (
  window: BrowserWindow,
  worktreeService: WorktreeService,
  gitService: GitService,
  codexManager: CodexSessionManager,
  terminalService: TerminalService
): void => {
  const sendState = (state: AppState) => {
    window.webContents.send(IPCChannels.stateUpdates, state);
  };

  ipcMain.handle(IPCChannels.getState, async () => {
    return worktreeService.getState();
  });

  ipcMain.handle(IPCChannels.selectRoot, async () => {
    console.log('[main] select root handler invoked');
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      console.log('[main] select root cancelled');
      return worktreeService.getState();
    }

    const selected = result.filePaths[0];
    await worktreeService.setProjectRoot(selected);
    console.log('[main] project root set', selected);
    return worktreeService.getState();
  });

  ipcMain.handle(IPCChannels.createWorktree, async (_event, payload: { featureName: string }) => {
    const descriptor = await worktreeService.createWorktree(payload.featureName);
    return descriptor;
  });

  ipcMain.handle(IPCChannels.removeWorktree, async (_event, payload: { worktreeId: string }) => {
    try {
      await codexManager.stop(payload.worktreeId);
    } catch (error) {
      if ((error as Error).message.startsWith('No running Codex session')) {
        // Ignore when no active session is present.
      } else {
        throw error;
      }
    }
    await worktreeService.removeWorktree(payload.worktreeId);
    return worktreeService.getState();
  });

  ipcMain.handle(IPCChannels.startCodex, async (_event, payload: { worktreeId: string }) => {
    const state = worktreeService.getState();
    const worktree = state.worktrees.find((item) => item.id === payload.worktreeId);
    if (!worktree) {
      throw new Error(`Unknown worktree ${payload.worktreeId}`);
    }
    const session = await codexManager.start(worktree);
    await worktreeService.refreshWorktrees();
    return session;
  });

  ipcMain.handle(IPCChannels.stopCodex, async (_event, payload: { worktreeId: string }) => {
    await codexManager.stop(payload.worktreeId);
    return codexManager.getSessions();
  });

  ipcMain.handle(IPCChannels.sendCodexInput, async (_event, payload: { worktreeId: string; input: string }) => {
    await codexManager.sendInput(payload.worktreeId, payload.input);
  });

  ipcMain.handle(IPCChannels.gitStatus, async (_event, payload: GitStatusRequest) => {
    return gitService.getStatus(payload.worktreeId);
  });

  ipcMain.handle(IPCChannels.gitDiff, async (_event, payload: GitDiffRequest) => {
    return gitService.getDiff(payload);
  });

  ipcMain.handle(IPCChannels.codexLog, async (_event, payload: CodexLogRequest) => {
    return codexManager.getLog(payload.worktreeId);
  });

  ipcMain.handle(IPCChannels.terminalStart, async (_event, payload: { worktreeId: string }) => {
    return terminalService.ensure(payload.worktreeId);
  });

  ipcMain.handle(IPCChannels.terminalStop, async (_event, payload: { worktreeId: string }) => {
    await terminalService.stop(payload.worktreeId);
  });

  ipcMain.handle(
    IPCChannels.terminalInput,
    async (_event, payload: { worktreeId: string; data: string }) => {
      terminalService.sendInput(payload.worktreeId, payload.data ?? '');
    }
  );

  ipcMain.handle(IPCChannels.terminalResize, async (_event, payload: TerminalResizeRequest) => {
    terminalService.resize(payload);
  });

  worktreeService.on('state-changed', sendState);
  worktreeService.on('worktree-updated', () => sendState(worktreeService.getState()));
  worktreeService.on('worktree-removed', (worktreeId) => {
    terminalService.dispose(worktreeId);
    sendState(worktreeService.getState());
  });

  codexManager.on('codex-output', (payload) => {
    window.webContents.send(IPCChannels.codexOutput, payload);
  });

  codexManager.on('codex-status', (payload) => {
    void worktreeService.updateCodexStatus(payload.worktreeId, payload.status, payload.error);
    window.webContents.send(IPCChannels.codexStatus, payload);
  });

  const forwardTerminalOutput = (payload: TerminalOutputPayload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPCChannels.terminalOutput, payload);
    }
  };

  const forwardTerminalExit = (payload: TerminalExitPayload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPCChannels.terminalExit, payload);
    }
  };

  terminalService.on('terminal-output', forwardTerminalOutput);
  terminalService.on('terminal-exit', forwardTerminalExit);

  window.on('closed', () => {
    ipcMain.removeHandler(IPCChannels.getState);
    ipcMain.removeHandler(IPCChannels.selectRoot);
    ipcMain.removeHandler(IPCChannels.createWorktree);
    ipcMain.removeHandler(IPCChannels.removeWorktree);
    ipcMain.removeHandler(IPCChannels.startCodex);
    ipcMain.removeHandler(IPCChannels.stopCodex);
    ipcMain.removeHandler(IPCChannels.gitStatus);
    ipcMain.removeHandler(IPCChannels.gitDiff);
    ipcMain.removeHandler(IPCChannels.codexLog);
    ipcMain.removeHandler(IPCChannels.sendCodexInput);
    ipcMain.removeHandler(IPCChannels.terminalStart);
    ipcMain.removeHandler(IPCChannels.terminalStop);
    ipcMain.removeHandler(IPCChannels.terminalInput);
    ipcMain.removeHandler(IPCChannels.terminalResize);
    worktreeService.removeAllListeners();
    codexManager.removeAllListeners();
    terminalService.off('terminal-output', forwardTerminalOutput);
    terminalService.off('terminal-exit', forwardTerminalExit);
  });
};
