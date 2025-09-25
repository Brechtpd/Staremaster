import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/api';

const IPCChannels = {
  getState: 'project:get-state',
  addProject: 'project:add',
  createWorktree: 'worktree:create',
  mergeWorktree: 'worktree:merge',
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
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  terminalStart: 'terminal:start',
  terminalStop: 'terminal:stop',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalOutput: 'terminal:output',
  terminalExit: 'terminal:exit',
  codexTerminalStart: 'codex-terminal:start',
  codexTerminalStop: 'codex-terminal:stop',
  codexTerminalInput: 'codex-terminal:input',
  codexTerminalResize: 'codex-terminal:resize',
  codexTerminalOutput: 'codex-terminal:output',
  codexTerminalExit: 'codex-terminal:exit'
} as const;

const api: RendererApi = {
  getState: () => ipcRenderer.invoke(IPCChannels.getState),
  addProject: () => ipcRenderer.invoke(IPCChannels.addProject),
  createWorktree: (projectId, featureName) =>
    ipcRenderer.invoke(IPCChannels.createWorktree, { projectId, featureName }),
  mergeWorktree: (worktreeId) => ipcRenderer.invoke(IPCChannels.mergeWorktree, { worktreeId }),
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
  startCodexTerminal: (worktreeId, options) =>
    ipcRenderer.invoke(IPCChannels.codexTerminalStart, {
      worktreeId,
      startupCommand: options?.startupCommand
    }),
  stopCodexTerminal: (worktreeId) => ipcRenderer.invoke(IPCChannels.codexTerminalStop, { worktreeId }),
  sendCodexTerminalInput: (worktreeId, data) =>
    ipcRenderer.invoke(IPCChannels.codexTerminalInput, { worktreeId, data }),
  resizeCodexTerminal: (request) => ipcRenderer.invoke(IPCChannels.codexTerminalResize, request),
  onStateUpdate: (callback) => subscribe(IPCChannels.stateUpdates, callback),
  onCodexOutput: (callback) => subscribe(IPCChannels.codexOutput, callback),
  onCodexStatus: (callback) => subscribe(IPCChannels.codexStatus, callback),
  getGitStatus: (worktreeId) => ipcRenderer.invoke(IPCChannels.gitStatus, { worktreeId }),
  getGitDiff: (request) => ipcRenderer.invoke(IPCChannels.gitDiff, request),
  getCodexLog: (worktreeId) => ipcRenderer.invoke(IPCChannels.codexLog, { worktreeId }),
  startWorktreeTerminal: (worktreeId) => ipcRenderer.invoke(IPCChannels.terminalStart, { worktreeId }),
  stopWorktreeTerminal: (worktreeId) => ipcRenderer.invoke(IPCChannels.terminalStop, { worktreeId }),
  sendTerminalInput: (worktreeId, data) =>
    ipcRenderer.invoke(IPCChannels.terminalInput, { worktreeId, data }),
  resizeTerminal: (request) => ipcRenderer.invoke(IPCChannels.terminalResize, request),
  onTerminalOutput: (callback) => subscribe(IPCChannels.terminalOutput, callback),
  onTerminalExit: (callback) => subscribe(IPCChannels.terminalExit, callback),
  onCodexTerminalOutput: (callback) => subscribe(IPCChannels.codexTerminalOutput, callback),
  onCodexTerminalExit: (callback) => subscribe(IPCChannels.codexTerminalExit, callback)
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
