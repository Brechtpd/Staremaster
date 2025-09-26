import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  IPCChannels,
  AppState,
  GitStatusRequest,
  GitDiffRequest,
  CodexLogRequest,
  CodexSummarizeRequest,
  TerminalResizeRequest,
  TerminalOutputPayload,
  TerminalExitPayload
} from '../../shared/ipc';
import { WorktreeService } from '../services/WorktreeService';
import { CodexSessionManager } from '../services/CodexSessionManager';
import { GitService } from '../services/GitService';
import { TerminalService } from '../services/TerminalService';
import { CodexSummarizer } from '../services/CodexSummarizer';

export const registerIpcHandlers = (
  window: BrowserWindow,
  worktreeService: WorktreeService,
  gitService: GitService,
  codexManager: CodexSessionManager,
  terminalService: TerminalService,
  codexTerminalService: TerminalService
): void => {
  const sendState = (state: AppState) => {
    window.webContents.send(IPCChannels.stateUpdates, state);
  };

  const codexSummarizer = new CodexSummarizer();

  ipcMain.handle(IPCChannels.getState, async () => {
    return worktreeService.getState();
  });

  ipcMain.handle(IPCChannels.addProject, async () => {
    console.log('[main] add project handler invoked');
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      console.log('[main] add project cancelled');
      return worktreeService.getState();
    }

    const selected = result.filePaths[0];
    await worktreeService.addProject(selected);
    console.log('[main] project added', selected);
    return worktreeService.getState();
  });

  ipcMain.handle(
    IPCChannels.createWorktree,
    async (_event, payload: { projectId: string; featureName: string }) => {
      const descriptor = await worktreeService.createWorktree(payload.projectId, payload.featureName);
      return descriptor;
    }
  );

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

  ipcMain.handle(
    IPCChannels.openWorktreeInFileManager,
    async (_event, payload: { worktreeId: string }) => {
      await worktreeService.openWorktreeInFileManager(payload.worktreeId);
    }
  );

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
    await worktreeService.refreshProjectWorktrees(worktree.projectId);
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

  ipcMain.handle(IPCChannels.codexSummarize, async (_event, payload: CodexSummarizeRequest) => {
    if (!payload || typeof payload.worktreeId !== 'string' || typeof payload.text !== 'string') {
      throw new Error('Invalid Codex summarize payload');
    }
    const worktreePath = worktreeService.getWorktreePath(payload.worktreeId);
    if (!worktreePath) {
      throw new Error(`Unknown worktree ${payload.worktreeId}`);
    }
    return codexSummarizer.summarize({
      text: payload.text,
      cwd: worktreePath
    });
  });

  ipcMain.handle(
    IPCChannels.codexSetResume,
    async (_event, payload: { worktreeId: string; command: string | null }) => {
      await worktreeService.setCodexResumeCommand(payload.worktreeId, payload.command);
    }
  );

  ipcMain.handle(
    IPCChannels.codexRefreshResume,
    async (_event, payload: { worktreeId: string }) => {
      return worktreeService.getCodexResumeCommand(payload.worktreeId);
    }
  );

  ipcMain.handle(
    IPCChannels.terminalStart,
    async (
      _event,
      payload: {
        worktreeId: string;
        paneId?: string;
        startupCommand?: string;
        respondToCursorProbe?: boolean;
      }
    ) => {
      return terminalService.ensure(
        payload.worktreeId,
        {
          startupCommand: payload.startupCommand,
          respondToCursorProbe: payload.respondToCursorProbe
        },
        payload.paneId
      );
    }
  );

  ipcMain.handle(
    IPCChannels.terminalStop,
    async (_event, payload: { worktreeId: string; sessionId?: string; paneId?: string }) => {
      await terminalService.stop(payload.worktreeId, {
        sessionId: payload.sessionId,
        paneId: payload.paneId
      });
    }
  );

  ipcMain.handle(
    IPCChannels.terminalInput,
    async (_event, payload: { worktreeId: string; data: string; sessionId?: string; paneId?: string }) => {
      terminalService.sendInput(payload.worktreeId, payload.data ?? '', {
        sessionId: payload.sessionId,
        paneId: payload.paneId
      });
    }
  );

  ipcMain.handle(IPCChannels.terminalResize, async (_event, payload: TerminalResizeRequest) => {
    terminalService.resize(payload);
  });

  ipcMain.handle(
    IPCChannels.codexTerminalStart,
    async (
      _event,
      payload: {
        worktreeId: string;
        startupCommand?: string;
        paneId?: string;
        respondToCursorProbe?: boolean;
      }
    ) => {
      return codexTerminalService.ensure(
        payload.worktreeId,
        {
          startupCommand: payload.startupCommand,
          respondToCursorProbe: payload.respondToCursorProbe
        },
        payload.paneId
      );
    }
  );

  ipcMain.handle(
    IPCChannels.codexTerminalStop,
    async (_event, payload: { worktreeId: string; sessionId?: string; paneId?: string }) => {
      await codexTerminalService.stop(payload.worktreeId, {
        sessionId: payload.sessionId,
        paneId: payload.paneId
      });
    }
  );

  ipcMain.handle(
    IPCChannels.codexTerminalInput,
    async (_event, payload: { worktreeId: string; data: string; sessionId?: string; paneId?: string }) => {
      codexTerminalService.sendInput(payload.worktreeId, payload.data ?? '', {
        sessionId: payload.sessionId,
        paneId: payload.paneId
      });
    }
  );

  ipcMain.handle(IPCChannels.codexTerminalResize, async (_event, payload: TerminalResizeRequest) => {
    codexTerminalService.resize(payload);
  });

  ipcMain.handle(
    IPCChannels.codexTerminalSnapshot,
    async (_event, payload: { worktreeId: string; paneId?: string }) => {
      return codexTerminalService.getSnapshot(payload.worktreeId, payload.paneId);
    }
  );

  ipcMain.handle(
    IPCChannels.codexTerminalDelta,
    async (
      _event,
      payload: { worktreeId: string; afterEventId: number; paneId?: string }
    ) => {
      return codexTerminalService.getDelta(payload.worktreeId, payload.afterEventId, payload.paneId);
    }
  );

  worktreeService.on('state-changed', sendState);
  worktreeService.on('worktree-updated', () => sendState(worktreeService.getState()));
  worktreeService.on('worktree-removed', (worktreeId) => {
    terminalService.dispose(worktreeId);
    codexTerminalService.dispose(worktreeId);
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

  const forwardCodexTerminalOutput = (payload: TerminalOutputPayload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPCChannels.codexTerminalOutput, payload);
    }
  };

  const forwardCodexTerminalExit = (payload: TerminalExitPayload) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPCChannels.codexTerminalExit, payload);
    }
  };

  codexTerminalService.on('terminal-output', forwardCodexTerminalOutput);
  codexTerminalService.on('terminal-exit', forwardCodexTerminalExit);

  window.on('closed', () => {
    ipcMain.removeHandler(IPCChannels.getState);
    ipcMain.removeHandler(IPCChannels.addProject);
    ipcMain.removeHandler(IPCChannels.createWorktree);
    ipcMain.removeHandler(IPCChannels.mergeWorktree);
    ipcMain.removeHandler(IPCChannels.removeWorktree);
    ipcMain.removeHandler(IPCChannels.openWorktreeInVSCode);
    ipcMain.removeHandler(IPCChannels.openWorktreeInGitGui);
    ipcMain.removeHandler(IPCChannels.openWorktreeInFileManager);
    ipcMain.removeHandler(IPCChannels.startCodex);
    ipcMain.removeHandler(IPCChannels.stopCodex);
    ipcMain.removeHandler(IPCChannels.gitStatus);
    ipcMain.removeHandler(IPCChannels.gitDiff);
    ipcMain.removeHandler(IPCChannels.codexLog);
    ipcMain.removeHandler(IPCChannels.codexSummarize);
    ipcMain.removeHandler(IPCChannels.sendCodexInput);
    ipcMain.removeHandler(IPCChannels.terminalStart);
    ipcMain.removeHandler(IPCChannels.terminalStop);
    ipcMain.removeHandler(IPCChannels.terminalInput);
    ipcMain.removeHandler(IPCChannels.terminalResize);
    ipcMain.removeHandler(IPCChannels.codexTerminalStart);
    ipcMain.removeHandler(IPCChannels.codexTerminalStop);
    ipcMain.removeHandler(IPCChannels.codexTerminalInput);
    ipcMain.removeHandler(IPCChannels.codexTerminalResize);
    ipcMain.removeHandler(IPCChannels.codexTerminalSnapshot);
    ipcMain.removeHandler(IPCChannels.codexTerminalDelta);
    worktreeService.removeAllListeners();
    codexManager.removeAllListeners();
    terminalService.off('terminal-output', forwardTerminalOutput);
    terminalService.off('terminal-exit', forwardTerminalExit);
    codexTerminalService.off('terminal-output', forwardCodexTerminalOutput);
    codexTerminalService.off('terminal-exit', forwardCodexTerminalExit);
  });
};
