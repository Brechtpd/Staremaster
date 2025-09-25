import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  IPCChannels,
  AppState,
  GitStatusRequest,
  GitDiffRequest,
  CodexLogRequest
} from '../../shared/ipc';
import { WorktreeService } from '../services/WorktreeService';
import { CodexSessionManager } from '../services/CodexSessionManager';
import { GitService } from '../services/GitService';

export const registerIpcHandlers = (
  window: BrowserWindow,
  worktreeService: WorktreeService,
  gitService: GitService,
  codexManager: CodexSessionManager
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

  ipcMain.handle(
    IPCChannels.removeWorktree,
    async (_event, payload: { worktreeId: string; deleteFolder?: boolean }) => {
      try {
        await codexManager.stop(payload.worktreeId);
      } catch (error) {
        if ((error as Error).message.startsWith('No running Codex session')) {
          // Ignore when no active session is present.
        } else {
          throw error;
        }
      }
      await worktreeService.removeWorktree(payload.worktreeId, {
        deleteFolder: Boolean(payload.deleteFolder)
      });
      return worktreeService.getState();
    }
  );

  ipcMain.handle(IPCChannels.openWorktreeInVSCode, async (_event, payload: { worktreeId: string }) => {
    await worktreeService.openWorktreeInVSCode(payload.worktreeId);
  });

  ipcMain.handle(IPCChannels.openWorktreeInGitGui, async (_event, payload: { worktreeId: string }) => {
    await worktreeService.openWorktreeInGitGui(payload.worktreeId);
  });

  ipcMain.handle(IPCChannels.mergeWorktree, async (_event, payload: { worktreeId: string }) => {
    return worktreeService.mergeWorktree(payload.worktreeId);
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

  worktreeService.on('state-changed', sendState);
  worktreeService.on('worktree-updated', () => sendState(worktreeService.getState()));
  worktreeService.on('worktree-removed', () => sendState(worktreeService.getState()));

  codexManager.on('codex-output', (payload) => {
    window.webContents.send(IPCChannels.codexOutput, payload);
  });

  codexManager.on('codex-status', (payload) => {
    void worktreeService.updateCodexStatus(payload.worktreeId, payload.status, payload.error);
    window.webContents.send(IPCChannels.codexStatus, payload);
  });

  window.on('closed', () => {
    ipcMain.removeHandler(IPCChannels.getState);
    ipcMain.removeHandler(IPCChannels.selectRoot);
    ipcMain.removeHandler(IPCChannels.createWorktree);
    ipcMain.removeHandler(IPCChannels.mergeWorktree);
    ipcMain.removeHandler(IPCChannels.removeWorktree);
    ipcMain.removeHandler(IPCChannels.openWorktreeInVSCode);
    ipcMain.removeHandler(IPCChannels.openWorktreeInGitGui);
    ipcMain.removeHandler(IPCChannels.startCodex);
    ipcMain.removeHandler(IPCChannels.stopCodex);
    ipcMain.removeHandler(IPCChannels.gitStatus);
    ipcMain.removeHandler(IPCChannels.gitDiff);
    ipcMain.removeHandler(IPCChannels.codexLog);
    ipcMain.removeHandler(IPCChannels.sendCodexInput);
    worktreeService.removeAllListeners();
    codexManager.removeAllListeners();
  });
};
