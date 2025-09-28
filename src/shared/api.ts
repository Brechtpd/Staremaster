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
  TerminalResizeRequest,
  TerminalSnapshot,
  TerminalDelta
} from './ipc';

export interface RendererApi {
  getState(): Promise<AppState>;
  addProject(): Promise<AppState>;
  removeProject(projectId: string): Promise<AppState>;
  createWorktree(projectId: string, featureName: string): Promise<WorktreeDescriptor>;
  mergeWorktree(worktreeId: string): Promise<AppState>;
  removeWorktree(worktreeId: string, deleteFolder?: boolean): Promise<AppState>;
  openWorktreeInVSCode(worktreeId: string): Promise<void>;
  openWorktreeInGitGui(worktreeId: string): Promise<void>;
  openWorktreeInFileManager(worktreeId: string): Promise<void>;
  startCodex(worktreeId: string): Promise<CodexSessionDescriptor>;
  stopCodex(worktreeId: string): Promise<CodexSessionDescriptor[]>;
  sendCodexInput(worktreeId: string, input: string): Promise<void>;
  onStateUpdate(callback: (state: AppState) => void): () => void;
  onCodexOutput(callback: (payload: CodexOutputPayload) => void): () => void;
  onCodexStatus(callback: (payload: CodexStatusPayload) => void): () => void;
  getGitStatus(worktreeId: string): Promise<GitStatusSummary>;
  getGitDiff(request: GitDiffRequest): Promise<GitDiffResponse>;
  getCodexLog(worktreeId: string): Promise<string>;
  summarizeCodexOutput(worktreeId: string, text: string): Promise<string>;
  refreshCodexSessionId(worktreeId: string, sessionId?: string | null): Promise<string | null>;
  listCodexSessions(worktreeId: string): Promise<Array<{ id: string; mtimeMs: number; preview: string }>>;
  startWorktreeTerminal(
    worktreeId: string,
    options?: { paneId?: string; startupCommand?: string; respondToCursorProbe?: boolean }
  ): Promise<WorktreeTerminalDescriptor>;
  stopWorktreeTerminal(worktreeId: string, options?: { sessionId?: string; paneId?: string }): Promise<void>;
  sendTerminalInput(
    worktreeId: string,
    data: string,
    options?: { sessionId?: string; paneId?: string }
  ): Promise<void>;
  resizeTerminal(request: TerminalResizeRequest): Promise<void>;
  getTerminalSnapshot(worktreeId: string, options?: { paneId?: string }): Promise<TerminalSnapshot>;
  getTerminalDelta(worktreeId: string, afterEventId: number, options?: { paneId?: string }): Promise<TerminalDelta>;
  onTerminalOutput(callback: (payload: TerminalOutputPayload) => void): () => void;
  onTerminalExit(callback: (payload: TerminalExitPayload) => void): () => void;
}
