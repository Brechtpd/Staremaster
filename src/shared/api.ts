import {
  AppState,
  WorktreeDescriptor,
  CodexSessionDescriptor,
  CodexOutputPayload,
  CodexStatusPayload,
  GitStatusSummary,
  GitDiffRequest,
  GitDiffResponse
} from './ipc';

export interface RendererApi {
  getState(): Promise<AppState>;
  selectProjectRoot(): Promise<AppState>;
  createWorktree(featureName: string): Promise<WorktreeDescriptor>;
  mergeWorktree(worktreeId: string): Promise<AppState>;
  removeWorktree(worktreeId: string, deleteFolder?: boolean): Promise<AppState>;
  openWorktreeInVSCode(worktreeId: string): Promise<void>;
  openWorktreeInGitGui(worktreeId: string): Promise<void>;
  startCodex(worktreeId: string): Promise<CodexSessionDescriptor>;
  stopCodex(worktreeId: string): Promise<CodexSessionDescriptor[]>;
  sendCodexInput(worktreeId: string, input: string): Promise<void>;
  onStateUpdate(callback: (state: AppState) => void): () => void;
  onCodexOutput(callback: (payload: CodexOutputPayload) => void): () => void;
  onCodexStatus(callback: (payload: CodexStatusPayload) => void): () => void;
  getGitStatus(worktreeId: string): Promise<GitStatusSummary>;
  getGitDiff(request: GitDiffRequest): Promise<GitDiffResponse>;
  getCodexLog(worktreeId: string): Promise<string>;
}
