import type {
  OrchestratorBriefingInput,
  OrchestratorCommentInput,
  OrchestratorFollowUpInput,
  OrchestratorRunSummary,
  OrchestratorSnapshot,
  WorkerRole
} from './orchestrator';

type IpcChannelMap = {
  getState: 'project:get-state';
  addProject: 'project:add';
  removeProject: 'project:remove';
  createWorktree: 'worktree:create';
  mergeWorktree: 'worktree:merge';
  removeWorktree: 'worktree:remove';
  openWorktreeInVSCode: 'worktree:open-vscode';
  openWorktreeInGitGui: 'worktree:open-git-gui';
  openWorktreeInFileManager: 'worktree:open-file-manager';
  startCodex: 'codex:start';
  stopCodex: 'codex:stop';
  sendCodexInput: 'codex:input';
  stateUpdates: 'state:update';
  codexOutput: 'codex:output';
  codexStatus: 'codex:status';
  codexLog: 'codex:log';
  codexSummarize: 'codex:summarize';
  codexRefreshSessionId: 'codex:refresh-session-id';
  codexListSessions: 'codex:list-sessions';
  gitStatus: 'git:status';
  gitDiff: 'git:diff';
  terminalStart: 'terminal:start';
  terminalStop: 'terminal:stop';
  terminalInput: 'terminal:input';
  terminalResize: 'terminal:resize';
  terminalOutput: 'terminal:output';
  terminalExit: 'terminal:exit';
  terminalSnapshot: 'terminal:snapshot';
  terminalDelta: 'terminal:delta';
  orchestratorSnapshot: 'orchestrator:snapshot';
  orchestratorStart: 'orchestrator:start';
  orchestratorFollowUp: 'orchestrator:follow-up';
  orchestratorApprove: 'orchestrator:approve';
  orchestratorComment: 'orchestrator:comment';
  orchestratorEvent: 'orchestrator:event';
  orchestratorStartWorkers: 'orchestrator:start-workers';
  orchestratorStopWorkers: 'orchestrator:stop-workers';
  orchestratorConfigureWorkers: 'orchestrator:configure-workers';
  orchestratorStopRun: 'orchestrator:stop-run';
  orchestratorOpenPath: 'orchestrator:open-path';
};

export const IPCChannels: IpcChannelMap = {
  getState: 'project:get-state',
  addProject: 'project:add',
  removeProject: 'project:remove',
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
  codexRefreshSessionId: 'codex:refresh-session-id',
  codexListSessions: 'codex:list-sessions',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  terminalStart: 'terminal:start',
  terminalStop: 'terminal:stop',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalOutput: 'terminal:output',
  terminalExit: 'terminal:exit',
  terminalSnapshot: 'terminal:snapshot',
  terminalDelta: 'terminal:delta',
  orchestratorSnapshot: 'orchestrator:snapshot',
  orchestratorStart: 'orchestrator:start',
  orchestratorFollowUp: 'orchestrator:follow-up',
  orchestratorApprove: 'orchestrator:approve',
  orchestratorComment: 'orchestrator:comment',
  orchestratorEvent: 'orchestrator:event',
  orchestratorStartWorkers: 'orchestrator:start-workers',
  orchestratorStopWorkers: 'orchestrator:stop-workers',
  orchestratorConfigureWorkers: 'orchestrator:configure-workers',
  orchestratorStopRun: 'orchestrator:stop-run',
  orchestratorOpenPath: 'orchestrator:open-path'
};

export const ORCHESTRATOR_OPEN_PATH_CHANNEL = IPCChannels.orchestratorOpenPath;

type ValueOf<T> = T[keyof T];

export type IpcChannel = ValueOf<typeof IPCChannels>;

export type WorktreeStatus = 'idle' | 'creating' | 'ready' | 'merging' | 'removing' | 'error';
export type CodexStatus = 'idle' | 'starting' | 'resuming' | 'running' | 'stopped' | 'error';

export interface ProjectDescriptor {
  id: string;
  root: string;
  name: string;
  createdAt: string;
  defaultWorktreeId?: string;
  lastCodexWorktreeId?: string;
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
  paneId?: string;
  eventId?: number;
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

export interface TerminalChunk {
  id: number;
  data: string;
}

export interface TerminalSnapshot {
  content: string;
  lastEventId: number;
}

export interface TerminalDelta {
  chunks: TerminalChunk[];
  lastEventId: number;
  snapshot?: string;
}

export interface OrchestratorSnapshotRequest {
  worktreeId: string;
}

export interface OrchestratorStartRequest {
  worktreeId: string;
  input: OrchestratorBriefingInput;
}

export interface OrchestratorStartResponse {
  run: OrchestratorRunSummary;
}

export interface OrchestratorFollowUpRequest {
  worktreeId: string;
  input: OrchestratorFollowUpInput;
}

export interface OrchestratorFollowUpResponse {
  run: OrchestratorRunSummary;
}

export interface OrchestratorApproveRequest {
  worktreeId: string;
  taskId: string;
  approver: string;
}

export interface OrchestratorCommentRequest {
  worktreeId: string;
  input: OrchestratorCommentInput;
}

export interface OrchestratorWorkersRequest {
  worktreeId: string;
  roles?: WorkerRole[];
  configs?: Array<{ role: WorkerRole; count: number; modelPriority: string[] }>;
}

export interface OrchestratorSnapshotResponse {
  snapshot: OrchestratorSnapshot | null;
}
