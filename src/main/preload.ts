import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi } from '../shared/api';

const IPCChannels = {
  getState: 'project:get-state',
  selectRoot: 'project:select-root',
  createWorktree: 'worktree:create',
  mergeWorktree: 'worktree:merge',
  removeWorktree: 'worktree:remove',
  openWorktreeInVSCode: 'worktree:open-vscode',
  openWorktreeInGitGui: 'worktree:open-git-gui',
  startCodex: 'codex:start',
  stopCodex: 'codex:stop',
  sendCodexInput: 'codex:input',
  stateUpdates: 'state:update',
  codexOutput: 'codex:output',
  codexStatus: 'codex:status',
  codexLog: 'codex:log',
  gitStatus: 'git:status',
  gitDiff: 'git:diff'
} as const;

const api: RendererApi = {
  getState: () => ipcRenderer.invoke(IPCChannels.getState),
  selectProjectRoot: () => ipcRenderer.invoke(IPCChannels.selectRoot),
  createWorktree: (featureName) => ipcRenderer.invoke(IPCChannels.createWorktree, { featureName }),
  mergeWorktree: (worktreeId) => ipcRenderer.invoke(IPCChannels.mergeWorktree, { worktreeId }),
  removeWorktree: (worktreeId, deleteFolder) =>
    ipcRenderer.invoke(IPCChannels.removeWorktree, { worktreeId, deleteFolder }),
  openWorktreeInVSCode: (worktreeId) =>
    ipcRenderer.invoke(IPCChannels.openWorktreeInVSCode, { worktreeId }),
  openWorktreeInGitGui: (worktreeId) =>
    ipcRenderer.invoke(IPCChannels.openWorktreeInGitGui, { worktreeId }),
  startCodex: (worktreeId) => ipcRenderer.invoke(IPCChannels.startCodex, { worktreeId }),
  stopCodex: (worktreeId) => ipcRenderer.invoke(IPCChannels.stopCodex, { worktreeId }),
  sendCodexInput: (worktreeId, input) => ipcRenderer.invoke(IPCChannels.sendCodexInput, { worktreeId, input }),
  onStateUpdate: (callback) => subscribe(IPCChannels.stateUpdates, callback),
  onCodexOutput: (callback) => subscribe(IPCChannels.codexOutput, callback),
  onCodexStatus: (callback) => subscribe(IPCChannels.codexStatus, callback),
  getGitStatus: (worktreeId) => ipcRenderer.invoke(IPCChannels.gitStatus, { worktreeId }),
  getGitDiff: (request) => ipcRenderer.invoke(IPCChannels.gitDiff, request),
  getCodexLog: (worktreeId) => ipcRenderer.invoke(IPCChannels.codexLog, { worktreeId })
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
