import {
  AppState,
  WorktreeDescriptor,
  CodexSessionDescriptor,
  CodexOutputPayload,
  CodexStatusPayload,
  GitStatusSummary,
  GitDiffRequest,
  GitDiffResponse,
  WorktreeTerminalDescriptor,
  TerminalOutputPayload,
  TerminalExitPayload,
  TerminalResizeRequest
} from './ipc';

export interface RendererApi {
  getState(): Promise<AppState>;
  addProject(): Promise<AppState>;
  createWorktree(projectId: string, featureName: string): Promise<WorktreeDescriptor>;
  mergeWorktree(worktreeId: string): Promise<AppState>;
  removeWorktree(worktreeId: string, deleteFolder?: boolean): Promise<AppState>;
  openWorktreeInVSCode(worktreeId: string): Promise<void>;
  openWorktreeInGitGui(worktreeId: string): Promise<void>;
  openWorktreeInFileManager(worktreeId: string): Promise<void>;
  startCodex(worktreeId: string): Promise<CodexSessionDescriptor>;
  stopCodex(worktreeId: string): Promise<CodexSessionDescriptor[]>;
  sendCodexInput(worktreeId: string, input: string): Promise<void>;
  startCodexTerminal(worktreeId: string, options?: { startupCommand?: string }): Promise<WorktreeTerminalDescriptor>;
  stopCodexTerminal(worktreeId: string): Promise<void>;
  sendCodexTerminalInput(worktreeId: string, data: string): Promise<void>;
  resizeCodexTerminal(request: TerminalResizeRequest): Promise<void>;
  onStateUpdate(callback: (state: AppState) => void): () => void;
  onCodexOutput(callback: (payload: CodexOutputPayload) => void): () => void;
  onCodexStatus(callback: (payload: CodexStatusPayload) => void): () => void;
  getGitStatus(worktreeId: string): Promise<GitStatusSummary>;
  getGitDiff(request: GitDiffRequest): Promise<GitDiffResponse>;
  getCodexLog(worktreeId: string): Promise<string>;
  startWorktreeTerminal(worktreeId: string): Promise<WorktreeTerminalDescriptor>;
  stopWorktreeTerminal(worktreeId: string): Promise<void>;
  sendTerminalInput(worktreeId: string, data: string): Promise<void>;
  resizeTerminal(request: TerminalResizeRequest): Promise<void>;
  onTerminalOutput(callback: (payload: TerminalOutputPayload) => void): () => void;
  onTerminalExit(callback: (payload: TerminalExitPayload) => void): () => void;
  onCodexTerminalOutput(callback: (payload: TerminalOutputPayload) => void): () => void;
  onCodexTerminalExit(callback: (payload: TerminalExitPayload) => void): () => void;
}
