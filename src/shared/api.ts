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
  createWorktree(projectId: string, featureName: string): Promise<WorktreeDescriptor>;
  mergeWorktree(worktreeId: string): Promise<AppState>;
  removeWorktree(worktreeId: string, deleteFolder?: boolean): Promise<AppState>;
  openWorktreeInVSCode(worktreeId: string): Promise<void>;
  openWorktreeInGitGui(worktreeId: string): Promise<void>;
  openWorktreeInFileManager(worktreeId: string): Promise<void>;
  startCodex(worktreeId: string): Promise<CodexSessionDescriptor>;
  stopCodex(worktreeId: string): Promise<CodexSessionDescriptor[]>;
  sendCodexInput(worktreeId: string, input: string): Promise<void>;
  startCodexTerminal(
    worktreeId: string,
    options?: { startupCommand?: string; paneId?: string; respondToCursorProbe?: boolean }
  ): Promise<WorktreeTerminalDescriptor>;
  stopCodexTerminal(worktreeId: string, options?: { sessionId?: string; paneId?: string }): Promise<void>;
  sendCodexTerminalInput(
    worktreeId: string,
    data: string,
    options?: { sessionId?: string; paneId?: string }
  ): Promise<void>;
  resizeCodexTerminal(request: TerminalResizeRequest): Promise<void>;
  getCodexTerminalSnapshot(worktreeId: string, options?: { paneId?: string }): Promise<TerminalSnapshot>;
  getCodexTerminalDelta(
    worktreeId: string,
    afterEventId: number,
    options?: { paneId?: string }
  ): Promise<TerminalDelta>;
  onStateUpdate(callback: (state: AppState) => void): () => void;
  onCodexOutput(callback: (payload: CodexOutputPayload) => void): () => void;
  onCodexStatus(callback: (payload: CodexStatusPayload) => void): () => void;
  getGitStatus(worktreeId: string): Promise<GitStatusSummary>;
  getGitDiff(request: GitDiffRequest): Promise<GitDiffResponse>;
  getCodexLog(worktreeId: string): Promise<string>;
  summarizeCodexOutput(worktreeId: string, text: string): Promise<string>;
  setCodexResumeCommand(worktreeId: string, command: string | null): Promise<void>;
  refreshCodexResumeCommand(worktreeId: string): Promise<string | null>;
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
  onTerminalOutput(callback: (payload: TerminalOutputPayload) => void): () => void;
  onTerminalExit(callback: (payload: TerminalExitPayload) => void): () => void;
  onCodexTerminalOutput(callback: (payload: TerminalOutputPayload) => void): () => void;
  onCodexTerminalExit(callback: (payload: TerminalExitPayload) => void): () => void;
}
