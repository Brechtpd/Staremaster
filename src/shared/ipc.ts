export const IPCChannels = {
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

type ValueOf<T> = T[keyof T];

export type IpcChannel = ValueOf<typeof IPCChannels>;

export type WorktreeStatus = 'idle' | 'creating' | 'ready' | 'merging' | 'removing' | 'error';
export type CodexStatus = 'idle' | 'starting' | 'resuming' | 'running' | 'stopped' | 'error';

export interface WorktreeDescriptor {
  id: string;
  featureName: string;
  branch: string;
  path: string;
  createdAt: string;
  status: WorktreeStatus;
  codexStatus: CodexStatus;
  lastError?: string;
}

export interface CodexSessionDescriptor {
  id: string;
  worktreeId: string;
  status: CodexStatus;
  startedAt: string;
  lastOutputAt?: string;
  lastError?: string;
  codexSessionId?: string;
}

export interface AppState {
  projectRoot: string | null;
  worktrees: WorktreeDescriptor[];
  sessions: CodexSessionDescriptor[];
}

export interface SelectRootResult {
  projectRoot: string;
  worktrees: WorktreeDescriptor[];
}

export interface CodexOutputPayload {
  sessionId: string;
  worktreeId: string;
  chunk: string;
}

export interface CodexStatusPayload {
  sessionId: string;
  worktreeId: string;
  status: CodexStatus;
  error?: string;
}

export interface CodexLogRequest {
  worktreeId: string;
}

export interface GitFileChange {
  path: string;
  displayPath: string;
  index: string;
  workingTree: string;
}

export interface GitStatusSummary {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
}

export interface GitStatusRequest {
  worktreeId: string;
}

export interface GitDiffRequest {
  worktreeId: string;
  filePath: string;
  staged?: boolean;
}

export interface GitDiffResponse {
  filePath: string;
  staged: boolean;
  diff: string;
  binary: boolean;
}
