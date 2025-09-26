export const IPCChannels = {
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
  codexSummarize: 'codex:summarize',
  codexSetResume: 'codex:set-resume',
  codexRefreshResume: 'codex:refresh-resume',
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

type ValueOf<T> = T[keyof T];

export type IpcChannel = ValueOf<typeof IPCChannels>;

export type WorktreeStatus = 'idle' | 'creating' | 'ready' | 'merging' | 'removing' | 'error';
export type CodexStatus = 'idle' | 'starting' | 'resuming' | 'running' | 'stopped' | 'error';

export interface ProjectDescriptor {
  id: string;
  root: string;
  name: string;
  createdAt: string;
  codexResumeCommand?: string;
}

export interface WorktreeDescriptor {
  id: string;
  projectId: string;
  featureName: string;
  branch: string;
  path: string;
  createdAt: string;
  status: WorktreeStatus;
  codexStatus: CodexStatus;
  lastError?: string;
  codexResumeCommand?: string;
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
  projects: ProjectDescriptor[];
  worktrees: WorktreeDescriptor[];
  sessions: CodexSessionDescriptor[];
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

export interface CodexSummarizeRequest {
  worktreeId: string;
  text: string;
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

export interface WorktreeTerminalDescriptor {
  sessionId: string;
  worktreeId: string;
  shell: string;
  pid: number;
  startedAt: string;
  status: 'running' | 'exited';
  paneId?: string;
  exitCode?: number;
  signal?: string;
  lastError?: string;
}

export interface TerminalOutputPayload {
  sessionId: string;
  worktreeId: string;
  chunk: string;
}

export interface TerminalExitPayload {
  sessionId: string;
  worktreeId: string;
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalResizeRequest {
  worktreeId: string;
  cols: number;
  rows: number;
  sessionId?: string;
  paneId?: string;
}
