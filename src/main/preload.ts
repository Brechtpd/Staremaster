import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/api';

const IPCChannels = {
  getState: 'project:get-state',
  addProject: 'project:add',
  removeProject: 'project:remove',
  createWorktree: 'worktree:create',
  mergeWorktree: 'worktree:merge',
  pullWorktree: 'worktree:pull',
  removeWorktree: 'worktree:remove',
  openWorktreeInVSCode: 'worktree:open-vscode',
  openWorktreeInGitGui: 'worktree:open-git-gui',
  openWorktreeInFileManager: 'worktree:open-file-manager',
  startCodex: 'codex:start',
  stopCodex: 'codex:stop',
  sendCodexInput: 'codex:input',
  stateUpdates: 'state:update',
  codexOutput: 'codex:output',
  codexStatus: 'codex:status',
  codexLog: 'codex:log',
  codexSummarize: 'codex:summarize',
  codexRefreshSessionId: 'codex:refresh-session-id',
  codexListSessions: 'codex:list-sessions',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  setThemePreference: 'preferences:set-theme',
  terminalStart: 'terminal:start',
  terminalStop: 'terminal:stop',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalOutput: 'terminal:output',
  terminalExit: 'terminal:exit',
  terminalSnapshot: 'terminal:snapshot',
  terminalDelta: 'terminal:delta'
} as const;

const api: RendererApi = {
  getState: () => ipcRenderer.invoke(IPCChannels.getState),
  addProject: () => ipcRenderer.invoke(IPCChannels.addProject),
  removeProject: (projectId) => ipcRenderer.invoke(IPCChannels.removeProject, { projectId }),
  createWorktree: (projectId, featureName) =>
    ipcRenderer.invoke(IPCChannels.createWorktree, { projectId, featureName }),
  mergeWorktree: (worktreeId) => ipcRenderer.invoke(IPCChannels.mergeWorktree, { worktreeId }),
  pullWorktree: (worktreeId) => ipcRenderer.invoke(IPCChannels.pullWorktree, { worktreeId }),
  removeWorktree: (worktreeId, deleteFolder) =>
    ipcRenderer.invoke(IPCChannels.removeWorktree, { worktreeId, deleteFolder }),
  openWorktreeInVSCode: (worktreeId) =>
    ipcRenderer.invoke(IPCChannels.openWorktreeInVSCode, { worktreeId }),
  openWorktreeInGitGui: (worktreeId) =>
    ipcRenderer.invoke(IPCChannels.openWorktreeInGitGui, { worktreeId }),
  openWorktreeInFileManager: (worktreeId) =>
    ipcRenderer.invoke(IPCChannels.openWorktreeInFileManager, { worktreeId }),
  startCodex: (worktreeId) => ipcRenderer.invoke(IPCChannels.startCodex, { worktreeId }),
  stopCodex: (worktreeId) => ipcRenderer.invoke(IPCChannels.stopCodex, { worktreeId }),
  sendCodexInput: (worktreeId, input) => ipcRenderer.invoke(IPCChannels.sendCodexInput, { worktreeId, input }),
  onStateUpdate: (callback) => subscribe(IPCChannels.stateUpdates, callback),
  onCodexOutput: (callback) => subscribe(IPCChannels.codexOutput, callback),
  onCodexStatus: (callback) => subscribe(IPCChannels.codexStatus, callback),
  getGitStatus: (worktreeId) => ipcRenderer.invoke(IPCChannels.gitStatus, { worktreeId }),
  getGitDiff: (request) => ipcRenderer.invoke(IPCChannels.gitDiff, request),
  getCodexLog: (worktreeId) => ipcRenderer.invoke(IPCChannels.codexLog, { worktreeId }),
  summarizeCodexOutput: (worktreeId, text) =>
    ipcRenderer.invoke(IPCChannels.codexSummarize, { worktreeId, text }),
  refreshCodexSessionId: (worktreeId, sessionId) =>
    ipcRenderer.invoke(IPCChannels.codexRefreshSessionId, { worktreeId, sessionId }),
  listCodexSessions: (worktreeId) => ipcRenderer.invoke(IPCChannels.codexListSessions, { worktreeId }),
  startWorktreeTerminal: (worktreeId, options) =>
    ipcRenderer.invoke(IPCChannels.terminalStart, {
      worktreeId,
      paneId: options?.paneId,
      startupCommand: options?.startupCommand
    }),
  stopWorktreeTerminal: (worktreeId, options) =>
    ipcRenderer.invoke(IPCChannels.terminalStop, {
      worktreeId,
      sessionId: options?.sessionId,
      paneId: options?.paneId
    }),
  sendTerminalInput: (worktreeId, data, options) =>
    ipcRenderer.invoke(IPCChannels.terminalInput, {
      worktreeId,
      data,
      sessionId: options?.sessionId,
      paneId: options?.paneId
    }),
  resizeTerminal: (request) => ipcRenderer.invoke(IPCChannels.terminalResize, request),
  getTerminalSnapshot: (worktreeId, options) =>
    ipcRenderer.invoke(IPCChannels.terminalSnapshot, {
      worktreeId,
      paneId: options?.paneId
    }),
  getTerminalDelta: (worktreeId, afterEventId, options) =>
    ipcRenderer.invoke(IPCChannels.terminalDelta, {
      worktreeId,
      afterEventId,
      paneId: options?.paneId
    }),
  onTerminalOutput: (callback) => subscribe(IPCChannels.terminalOutput, callback),
  onTerminalExit: (callback) => subscribe(IPCChannels.terminalExit, callback),
  setThemePreference: (theme) => ipcRenderer.invoke(IPCChannels.setThemePreference, { theme })
};

const subscribe = <Payload>(channel: string, callback: (payload: Payload) => void): (() => void) => {
  const listener = (_event: unknown, payload: Payload) => callback(payload);
  ipcRenderer.on(channel, listener as never);
  return () => {
    ipcRenderer.removeListener(channel, listener as never);
  };
};

contextBridge.exposeInMainWorld('api', api);
console.log('[preload] context bridge initialised');
(globalThis as typeof globalThis & { dispatchEvent?: (event: Event) => boolean }).dispatchEvent?.(
  new Event('electron-bridge-ready')
);
