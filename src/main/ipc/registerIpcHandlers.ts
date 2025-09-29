import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
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
  OrchestratorSnapshotRequest,
  OrchestratorSnapshotResponse,
  OrchestratorStartRequest,
  OrchestratorStartResponse,
  OrchestratorFollowUpRequest,
  OrchestratorFollowUpResponse,
  OrchestratorApproveRequest,
  OrchestratorCommentRequest,
  OrchestratorWorkersRequest
} from '../../shared/ipc';
import type {
  OrchestratorBriefingInput,
  OrchestratorCommentInput,
  OrchestratorEvent,
  OrchestratorFollowUpInput,
  OrchestratorRunSummary,
  OrchestratorSnapshot,
  WorkerRole
} from '../../shared/orchestrator';
import { DEFAULT_COUNTS, DEFAULT_PRIORITY, WORKER_ROLES, type WorkerSpawnConfig } from '../../shared/orchestrator-config';
import type { WorkerContextPayload } from '../../shared/orchestrator-ipc';
import { WorktreeService } from '../services/WorktreeService';
import { CodexSessionManager } from '../services/CodexSessionManager';
import { GitService } from '../services/GitService';
import { TerminalService } from '../services/TerminalService';
import { CodexSummarizer } from '../services/CodexSummarizer';

type OrchestratorBridge = {
  on(listener: (event: OrchestratorEvent) => void): () => void;
  getSnapshot(worktreeId: string): Promise<OrchestratorSnapshot | null>;
  startRun(worktreeId: string, worktreePath: string, input: OrchestratorBriefingInput): Promise<OrchestratorRunSummary>;
  submitFollowUp(worktreeId: string, input: OrchestratorFollowUpInput): Promise<OrchestratorRunSummary>;
  approveTask(worktreeId: string, taskId: string, approver: string): Promise<void>;
  addComment(worktreeId: string, input: OrchestratorCommentInput): Promise<void>;
  handleWorktreeRemoved(worktreeId: string): void;
  startWorkers(worktreeId: string, context: WorkerContextPayload, configs: WorkerSpawnConfig[]): Promise<void>;
  stopWorkers(worktreeId: string, roles: WorkerRole[]): Promise<void>;
  stopRun(worktreeId: string): Promise<void>;
};

export const registerIpcHandlers = (
  window: BrowserWindow,
  worktreeService: WorktreeService,
  gitService: GitService,
  codexManager: CodexSessionManager,
  terminalService: TerminalService,
  orchestrator: OrchestratorBridge
): void => {
  const sendState = (state: AppState) => {
    window.webContents.send(IPCChannels.stateUpdates, state);
  };

  const orchestratorListener = (event: OrchestratorEvent) => {
    if (window.isDestroyed()) {
      unsubscribeOrchestrator();
      return;
    }
    window.webContents.send(IPCChannels.orchestratorEvent, event);
  };

  let unsubscribeOrchestrator = () => {};
  unsubscribeOrchestrator = orchestrator.on(orchestratorListener);

  window.on('closed', () => {
    unsubscribeOrchestrator();
  });

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

  const buildWorkerConfigs = (metadata?: OrchestratorSnapshot['metadata']): WorkerSpawnConfig[] => {
    return WORKER_ROLES.map((role) => {
      const count = Math.max(0, metadata?.workerCounts?.[role] ?? DEFAULT_COUNTS[role] ?? 0);
      const priority = (metadata?.modelPriority?.[role] ?? DEFAULT_PRIORITY[role] ?? []).filter(Boolean);
      return {
        role,
        count,
        modelPriority: priority.slice(0, 4)
      };
    });
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
      orchestrator.handleWorktreeRemoved(worktree.id);
      await orchestrator.stopWorkers(worktree.id, WORKER_ROLES).catch(() => {});
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
      const canonicalId = resolveCanonical(payload.worktreeId);
      try {
        await codexManager.stop(canonicalId);
      } catch (error) {
        if ((error as Error).message.startsWith('No running Codex session')) {
          // Ignore when no active session is present.
        } else {
          throw error;
        }
      }
      await worktreeService.removeWorktree(canonicalId, {
        deleteFolder: Boolean(payload.deleteFolder)
      });
      orchestrator.handleWorktreeRemoved(canonicalId);
      await orchestrator.stopWorkers(canonicalId, WORKER_ROLES).catch(() => {});
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
    IPCChannels.orchestratorSnapshot,
    async (_event, payload: OrchestratorSnapshotRequest): Promise<OrchestratorSnapshotResponse> => {
      const canonical = resolveCanonical(payload.worktreeId);
      const snapshot = await orchestrator.getSnapshot(canonical);
      return { snapshot };
    }
  );

  ipcMain.handle(
    IPCChannels.orchestratorStart,
    async (_event, payload: OrchestratorStartRequest): Promise<OrchestratorStartResponse> => {
      const canonical = resolveCanonical(payload.worktreeId);
      const worktreePath = worktreeService.getWorktreePath(canonical);
      if (!worktreePath) {
        throw new Error(`Unknown worktree ${canonical}`);
      }
      const run = await orchestrator.startRun(canonical, worktreePath, payload.input);
      const runRoot = path.join(worktreePath, 'codex-runs', run.runId);
      const context: WorkerContextPayload = {
        worktreePath,
        runId: run.runId,
        runRoot,
        tasksRoot: path.join(runRoot, 'tasks'),
        conversationRoot: path.join(runRoot, 'conversations')
      };
      if (payload.input.autoStartWorkers ?? true) {
        const snapshot = await orchestrator.getSnapshot(canonical);
        const configs = buildWorkerConfigs(snapshot?.metadata);
        await orchestrator.startWorkers(canonical, context, configs);
      } else {
        await orchestrator.startWorkers(canonical, context, []);
      }
      return { run };
    }
  );

  ipcMain.handle(
    IPCChannels.orchestratorFollowUp,
    async (_event, payload: OrchestratorFollowUpRequest): Promise<OrchestratorFollowUpResponse> => {
      const canonical = resolveCanonical(payload.worktreeId);
      const run = await orchestrator.submitFollowUp(canonical, payload.input);
      return { run };
    }
  );

  ipcMain.handle(
    IPCChannels.orchestratorApprove,
    async (_event, payload: OrchestratorApproveRequest) => {
      const canonical = resolveCanonical(payload.worktreeId);
      await orchestrator.approveTask(canonical, payload.taskId, payload.approver);
    }
  );

  ipcMain.handle(
    IPCChannels.orchestratorComment,
    async (_event, payload: OrchestratorCommentRequest) => {
      const canonical = resolveCanonical(payload.worktreeId);
      await orchestrator.addComment(canonical, payload.input);
    }
  );

  ipcMain.handle(
    IPCChannels.orchestratorStartWorkers,
    async (_event, payload: OrchestratorWorkersRequest) => {
      const canonical = resolveCanonical(payload.worktreeId);
      const worktreePath = worktreeService.getWorktreePath(canonical);
      if (!worktreePath) {
        throw new Error(`Unknown worktree ${canonical}`);
      }
      const snapshot = await orchestrator.getSnapshot(canonical);
      if (!snapshot) {
        throw new Error('No active orchestrator run to attach workers.');
      }
      const runId = snapshot.run.runId;
      const runRoot = path.join(worktreePath, 'codex-runs', runId);
      const context: WorkerContextPayload = {
        worktreePath,
        runId,
        runRoot,
        tasksRoot: path.join(runRoot, 'tasks'),
        conversationRoot: path.join(runRoot, 'conversations')
      };
      let configs;
      if (payload.configs && payload.configs.length > 0) {
        configs = payload.configs;
      } else if (payload.roles && payload.roles.length > 0) {
        configs = payload.roles.map((role) => ({
          role,
          count: snapshot.metadata?.workerCounts?.[role] ?? DEFAULT_COUNTS[role] ?? 1,
          modelPriority: [...(snapshot.metadata?.modelPriority?.[role] ?? DEFAULT_PRIORITY[role] ?? [])]
        }));
      } else {
        configs = buildWorkerConfigs(snapshot.metadata);
      }
      await orchestrator.startWorkers(canonical, context, configs);
    }
  );

  ipcMain.handle(
    IPCChannels.orchestratorConfigureWorkers,
    async (_event, payload: OrchestratorWorkersRequest) => {
      const canonical = resolveCanonical(payload.worktreeId);
      const worktreePath = worktreeService.getWorktreePath(canonical);
      if (!worktreePath) {
        throw new Error(`Unknown worktree ${canonical}`);
      }
      const snapshot = await orchestrator.getSnapshot(canonical);
      if (!snapshot) {
        throw new Error('No active orchestrator run to configure.');
      }
      const runRoot = path.join(worktreePath, 'codex-runs', snapshot.run.runId);
      const context: WorkerContextPayload = {
        worktreePath,
        runId: snapshot.run.runId,
        runRoot,
        tasksRoot: path.join(runRoot, 'tasks'),
        conversationRoot: path.join(runRoot, 'conversations')
      };
      const configs = payload.configs && payload.configs.length > 0 ? payload.configs : buildWorkerConfigs(snapshot.metadata);
      await orchestrator.startWorkers(canonical, context, configs);
    }
  );

  ipcMain.handle(
    IPCChannels.orchestratorStopWorkers,
    async (_event, payload: OrchestratorWorkersRequest) => {
      const canonical = resolveCanonical(payload.worktreeId);
      const roles = payload.roles && payload.roles.length > 0 ? payload.roles : WORKER_ROLES;
      await orchestrator.stopWorkers(canonical, roles);
    }
  );

  ipcMain.handle(
    IPCChannels.orchestratorStopRun,
    async (_event, payload: { worktreeId: string }) => {
      const canonical = resolveCanonical(payload.worktreeId);
      await orchestrator.stopRun(canonical);
    }
  );

  ipcMain.handle(
    IPCChannels.orchestratorOpenPath,
    async (_event, payload: { worktreeId: string; relativePath: string }) => {
      const canonical = resolveCanonical(payload.worktreeId);
      const worktreePath = worktreeService.getWorktreePath(canonical);
      if (!worktreePath) {
        throw new Error(`Unknown worktree ${canonical}`);
      }
      const targetPath = path.isAbsolute(payload.relativePath)
        ? payload.relativePath
        : path.join(worktreePath, payload.relativePath);
      return await shell.openPath(targetPath);
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
    ipcMain.removeHandler(IPCChannels.terminalSnapshot);
    ipcMain.removeHandler(IPCChannels.terminalDelta);
    worktreeService.removeAllListeners();
    codexManager.removeAllListeners();
    terminalService.off('terminal-output', forwardTerminalOutput);
    terminalService.off('terminal-exit', forwardTerminalExit);
  });
};
