import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/api';

const IPCChannels = {
  getState: 'project:get-state',
  selectRoot: 'project:select-root',
  createWorktree: 'worktree:create',
  removeWorktree: 'worktree:remove',
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
  terminalExit: 'terminal:exit'
} as const;

const api: RendererApi = {
  getState: () => ipcRenderer.invoke(IPCChannels.getState),
  selectProjectRoot: () => ipcRenderer.invoke(IPCChannels.selectRoot),
  createWorktree: (featureName) => ipcRenderer.invoke(IPCChannels.createWorktree, { featureName }),
  removeWorktree: (worktreeId) => ipcRenderer.invoke(IPCChannels.removeWorktree, { worktreeId }),
  startCodex: (worktreeId) => ipcRenderer.invoke(IPCChannels.startCodex, { worktreeId }),
  stopCodex: (worktreeId) => ipcRenderer.invoke(IPCChannels.stopCodex, { worktreeId }),
  sendCodexInput: (worktreeId, input) => ipcRenderer.invoke(IPCChannels.sendCodexInput, { worktreeId, input }),
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
  onTerminalExit: (callback) => subscribe(IPCChannels.terminalExit, callback)
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
