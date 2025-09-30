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
  TerminalExitPayload,
  ThemePreference
} from '../../shared/ipc';
import { WorktreeService } from '../services/WorktreeService';
import { CodexSessionManager } from '../services/CodexSessionManager';
import { GitService } from '../services/GitService';
import { TerminalService } from '../services/TerminalService';
import { CodexSummarizer } from '../services/CodexSummarizer';

interface RegisterIpcHandlersOptions {
  onThemeChange?: (theme: ThemePreference) => void;
}

export const registerIpcHandlers = (
  window: BrowserWindow,
  worktreeService: WorktreeService,
  gitService: GitService,
  codexManager: CodexSessionManager,
  terminalService: TerminalService,
  options?: RegisterIpcHandlersOptions
): void => {
  const sendState = (state: AppState) => {
    window.webContents.send(IPCChannels.stateUpdates, state);
  };

  const codexSummarizer = new CodexSummarizer();
  const resolveCanonical = (worktreeId: string): string => {
    const resolved = worktreeService.resolveCanonicalWorktreeId(worktreeId);
    if (resolved) {
      return resolved;
    }
    if (worktreeId.startsWith('project-root:')) {
      throw new Error(`No canonical worktree found for ${worktreeId}`);
    }
    return worktreeId;
  };

  const maybeMirrorPayload = <T extends { worktreeId: string }>(payload: T): [T, T | null] => {
    return [payload, null];
  };

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

  ipcMain.handle(IPCChannels.removeProject, async (_event, payload: { projectId: string }) => {
    const state = worktreeService.getState();
    const relatedWorktrees = state.worktrees.filter((worktree) => worktree.projectId === payload.projectId);

    for (const worktree of relatedWorktrees) {
      try {
        await codexManager.stop(worktree.id);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('No running Codex session')) {
          throw error;
        }
      }
      terminalService.dispose(worktree.id);
    }

    await worktreeService.removeProject(payload.projectId);
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

  ipcMain.handle(IPCChannels.pullWorktree, async (_event, payload: { worktreeId: string }) => {
    return worktreeService.pullWorktree(payload.worktreeId);
  });

  ipcMain.handle(IPCChannels.startCodex, async (_event, payload: { worktreeId: string }) => {
    const canonicalId = resolveCanonical(payload.worktreeId);
    const state = worktreeService.getState();
    const worktree = state.worktrees.find((item) => item.id === canonicalId);
    if (!worktree) {
      throw new Error(`Unknown worktree ${payload.worktreeId}`);
    }
    const session = await codexManager.start(worktree);
    await worktreeService.refreshProjectWorktrees(worktree.projectId);
    return session;
  });

  ipcMain.handle(IPCChannels.stopCodex, async (_event, payload: { worktreeId: string }) => {
    await codexManager.stop(resolveCanonical(payload.worktreeId));
    return codexManager.getSessions();
  });

  ipcMain.handle(IPCChannels.sendCodexInput, async (_event, payload: { worktreeId: string; input: string }) => {
    await codexManager.sendInput(resolveCanonical(payload.worktreeId), payload.input);
  });

  ipcMain.handle(IPCChannels.gitStatus, async (_event, payload: GitStatusRequest) => {
    return gitService.getStatus(payload.worktreeId);
  });

  ipcMain.handle(IPCChannels.gitDiff, async (_event, payload: GitDiffRequest) => {
    return gitService.getDiff(payload);
  });

  ipcMain.handle(IPCChannels.codexLog, async (_event, payload: CodexLogRequest) => {
    return codexManager.getLog(resolveCanonical(payload.worktreeId));
  });

  ipcMain.handle(IPCChannels.codexSummarize, async (_event, payload: CodexSummarizeRequest) => {
    if (!payload || typeof payload.worktreeId !== 'string' || typeof payload.text !== 'string') {
      throw new Error('Invalid Codex summarize payload');
    }
    const worktreePath = worktreeService.getWorktreePath(resolveCanonical(payload.worktreeId));
    if (!worktreePath) {
      throw new Error(`Unknown worktree ${payload.worktreeId}`);
    }
    return codexSummarizer.summarize({
      text: payload.text,
      cwd: worktreePath
    });
  });

  ipcMain.handle(
    IPCChannels.codexRefreshSessionId,
    async (_event, payload: { worktreeId: string; sessionId?: string | null }) => {
      const canonical = resolveCanonical(payload.worktreeId);
      const sessionId = await codexManager.refreshCodexSessionId(canonical, payload.sessionId);
      const updated = worktreeService.getState();
      sendState(updated);
      return sessionId;
    }
  );

  ipcMain.handle(
    IPCChannels.codexListSessions,
    async (_event, payload: { worktreeId: string }) => {
      const canonical = resolveCanonical(payload.worktreeId);
      return codexManager.listCodexSessionCandidates(canonical);
    }
  );

  ipcMain.handle(
    IPCChannels.setThemePreference,
    async (_event, payload: { theme: ThemePreference }) => {
      const theme = payload?.theme === 'dark' ? 'dark' : 'light';
      const nextState = await worktreeService.setThemePreference(theme);
      options?.onThemeChange?.(theme);
      return nextState;
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
      }
    ) => {
      return terminalService.ensure(
        resolveCanonical(payload.worktreeId),
        {
          startupCommand: payload.startupCommand
        },
        payload.paneId
      );
    }
  );

  ipcMain.handle(
    IPCChannels.terminalStop,
    async (_event, payload: { worktreeId: string; sessionId?: string; paneId?: string }) => {
      await terminalService.stop(resolveCanonical(payload.worktreeId), {
        sessionId: payload.sessionId,
        paneId: payload.paneId
      });
    }
  );

  ipcMain.handle(
    IPCChannels.terminalInput,
    async (_event, payload: { worktreeId: string; data: string; sessionId?: string; paneId?: string }) => {
      terminalService.sendInput(resolveCanonical(payload.worktreeId), payload.data ?? '', {
        sessionId: payload.sessionId,
        paneId: payload.paneId
      });
    }
  );

  ipcMain.handle(IPCChannels.terminalResize, async (_event, payload: TerminalResizeRequest) => {
    terminalService.resize({ ...payload, worktreeId: resolveCanonical(payload.worktreeId) });
  });

  ipcMain.handle(
    IPCChannels.terminalSnapshot,
    async (_event, payload: { worktreeId: string; paneId?: string }) => {
      return terminalService.getSnapshot(resolveCanonical(payload.worktreeId), payload.paneId);
    }
  );

  ipcMain.handle(
    IPCChannels.terminalDelta,
    async (_event, payload: { worktreeId: string; afterEventId: number; paneId?: string }) => {
      return terminalService.getDelta(resolveCanonical(payload.worktreeId), payload.afterEventId, payload.paneId);
    }
  );

  worktreeService.on('state-changed', sendState);
  worktreeService.on('worktree-updated', () => sendState(worktreeService.getState()));
  worktreeService.on('worktree-removed', (worktreeId) => {
    terminalService.dispose(worktreeId);
    sendState(worktreeService.getState());
  });

  codexManager.on('codex-output', (payload) => {
    if (window.isDestroyed()) return;
    const [original, mirror] = maybeMirrorPayload(payload);
    window.webContents.send(IPCChannels.codexOutput, original);
    if (mirror) {
      window.webContents.send(IPCChannels.codexOutput, mirror);
    }
  });

  codexManager.on('codex-status', (payload) => {
    if (window.isDestroyed()) return;
    void worktreeService.updateCodexStatus(payload.worktreeId, payload.status, payload.error);
    const [original, mirror] = maybeMirrorPayload(payload);
    window.webContents.send(IPCChannels.codexStatus, original);
    if (mirror) {
      window.webContents.send(IPCChannels.codexStatus, mirror);
    }
  });

  const forwardTerminalOutput = (payload: TerminalOutputPayload) => {
    if (window.isDestroyed()) return;
    const [original, mirror] = maybeMirrorPayload(payload);
    window.webContents.send(IPCChannels.terminalOutput, original);
    if (mirror) {
      window.webContents.send(IPCChannels.terminalOutput, mirror);
    }
  };

  const forwardTerminalExit = (payload: TerminalExitPayload) => {
    if (window.isDestroyed()) return;
    const [original, mirror] = maybeMirrorPayload(payload);
    window.webContents.send(IPCChannels.terminalExit, original);
    if (mirror) {
      window.webContents.send(IPCChannels.terminalExit, mirror);
    }
  };

  terminalService.on('terminal-output', forwardTerminalOutput);
  terminalService.on('terminal-exit', forwardTerminalExit);

  window.on('closed', () => {
    ipcMain.removeHandler(IPCChannels.getState);
    ipcMain.removeHandler(IPCChannels.addProject);
    ipcMain.removeHandler(IPCChannels.createWorktree);
    ipcMain.removeHandler(IPCChannels.mergeWorktree);
    ipcMain.removeHandler(IPCChannels.pullWorktree);
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
    ipcMain.removeHandler(IPCChannels.setThemePreference);
    ipcMain.removeHandler(IPCChannels.terminalStart);
    ipcMain.removeHandler(IPCChannels.terminalStop);
    ipcMain.removeHandler(IPCChannels.terminalInput);
    ipcMain.removeHandler(IPCChannels.terminalResize);
    ipcMain.removeHandler(IPCChannels.terminalSnapshot);
    ipcMain.removeHandler(IPCChannels.terminalDelta);
    worktreeService.removeAllListeners();
    codexManager.removeAllListeners();
    terminalService.off('terminal-output', forwardTerminalOutput);
    terminalService.off('terminal-exit', forwardTerminalExit);
  });
};
