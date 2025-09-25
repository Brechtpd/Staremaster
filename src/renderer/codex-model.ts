import type {
  WorktreeDescriptor,
  CodexSessionDescriptor,
  CodexStatus
} from '@shared/ipc';

export type CodexUiStatus = 'idle' | 'starting' | 'resuming' | 'running' | 'stopping' | 'stopped' | 'error';

export interface DerivedCodexSession {
  status: CodexUiStatus;
  lastError?: string;
  sessionId?: string;
  codexSessionId?: string;
  startedAt?: string;
  signature: string;
}

const INTERACTIVE_CODEX_STATUSES: CodexUiStatus[] = ['running', 'starting', 'resuming'];

export const isInteractiveStatus = (status: CodexUiStatus): boolean => INTERACTIVE_CODEX_STATUSES.includes(status);

export const canAutoStart = (status: CodexUiStatus): boolean => ['idle', 'stopped', 'error'].includes(status);

export const mapCodexStatus = (status: CodexStatus): CodexUiStatus => {
  switch (status) {
    case 'starting':
      return 'starting';
    case 'resuming':
      return 'resuming';
    case 'running':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
};

export const buildCodexSessions = (
  worktrees: WorktreeDescriptor[],
  latestSessions: Map<string, CodexSessionDescriptor>
): Map<string, DerivedCodexSession> => {
  const result = new Map<string, DerivedCodexSession>();

  worktrees.forEach((worktree) => {
    result.set(worktree.id, {
      status: mapCodexStatus(worktree.codexStatus),
      lastError: worktree.lastError,
      signature: `worktree:${worktree.codexStatus}:${worktree.lastError ?? ''}`
    });
  });

  latestSessions.forEach((session, worktreeId) => {
    result.set(worktreeId, {
      status: mapCodexStatus(session.status),
      lastError: session.lastError,
      sessionId: session.id,
      codexSessionId: session.codexSessionId,
      startedAt: session.startedAt,
      signature: `session:${session.id}:${session.startedAt}:${session.codexSessionId ?? ''}:${session.status}:${session.lastError ?? ''}`
    });
  });

  return result;
};

export const getLatestSessionsByWorktree = (
  sessions: CodexSessionDescriptor[]
): Map<string, CodexSessionDescriptor> => {
  const map = new Map<string, CodexSessionDescriptor>();
  sessions.forEach((session) => {
    const current = map.get(session.worktreeId);
    if (!current) {
      map.set(session.worktreeId, session);
      return;
    }
    const currentTime = Date.parse(current.startedAt ?? '') || 0;
    const candidateTime = Date.parse(session.startedAt ?? '') || 0;
    if (candidateTime >= currentTime) {
      map.set(session.worktreeId, session);
    }
  });
  return map;
};
