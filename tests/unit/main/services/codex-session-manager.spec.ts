import { describe, expect, it, vi } from 'vitest';
import { CodexSessionManager } from '../../../../src/main/services/CodexSessionManager';
import type { ProjectStore } from '../../../../src/main/services/ProjectStore';

const createStore = () => {
  const state = {
    projects: [
      {
        id: 'proj',
        root: '/tmp/proj',
        name: 'proj',
        createdAt: new Date().toISOString(),
        defaultWorktreeId: undefined as string | undefined
      }
    ],
    worktrees: [
      {
        id: 'wt-1',
        projectId: 'proj',
        featureName: 'alpha',
        branch: 'alpha',
        path: '/tmp/proj/alpha',
        createdAt: new Date().toISOString(),
        status: 'ready' as const,
        codexStatus: 'idle' as const,
        lastError: undefined
      }
    ],
    sessions: [
      {
        id: 'session-record-1',
        worktreeId: 'wt-1',
        status: 'running' as const,
        startedAt: new Date().toISOString(),
        codexSessionId: 'old-session-id'
      }
    ]
  };

  return {
    getState: vi.fn(() => state),
    patchSession: vi.fn(),
    upsertSession: vi.fn(),
    patchWorktree: vi.fn(),
    upsertWorktree: vi.fn(),
    upsertProject: vi.fn(),
    setProjectDefaultWorktree: vi.fn(),
    patchProject: vi.fn(),
    removeSession: vi.fn(),
    removeWorktree: vi.fn(),
    removeProject: vi.fn(),
    getUserDataDir: vi.fn(() => '/tmp')
  } as unknown as ProjectStore & {
    getState: ReturnType<typeof vi.fn>;
    upsertSession: ReturnType<typeof vi.fn>;
    patchSession: ReturnType<typeof vi.fn>;
    setProjectDefaultWorktree: ReturnType<typeof vi.fn>;
  };
};

describe('CodexSessionManager', () => {
  it('refreshes session ids via ~/.codex/sessions', async () => {
    const store = createStore();
    const manager = new CodexSessionManager(store as unknown as ProjectStore);
    const collectSpy = vi
      .spyOn(
        manager as unknown as {
          collectCodexSessionCandidates(
            root: string,
            cwd: string,
            sessionStart: number,
            lookback: number
          ): Promise<Array<{ id: string; filePath: string; mtimeMs: number }>>;
        },
        'collectCodexSessionCandidates'
      )
      .mockResolvedValue([
        { id: 'captured-session-id', filePath: '/tmp/file.jsonl', mtimeMs: Date.now() }
      ]);
    vi.spyOn(
      manager as unknown as {
        readSessionPreview(filePath: string): Promise<string>;
      },
      'readSessionPreview'
    ).mockResolvedValue('preview');

    const result = await manager.refreshCodexSessionId('wt-1');

    expect(result).toBe('captured-session-id');
    expect(collectSpy).toHaveBeenCalled();
    expect(store.patchSession).toHaveBeenCalledWith(expect.any(String), { codexSessionId: 'captured-session-id' });
    expect(store.setProjectDefaultWorktree).toHaveBeenCalledWith('proj', 'wt-1');
  });

  it('applies a preferred session id when provided', async () => {
    const store = createStore();
    const manager = new CodexSessionManager(store as unknown as ProjectStore);
    const collectSpy = vi
      .spyOn(
        manager as unknown as {
          collectCodexSessionCandidates(
            root: string,
            cwd: string,
            sessionStart: number,
            lookback: number
          ): Promise<Array<{ id: string; filePath: string; mtimeMs: number }>>;
        },
        'collectCodexSessionCandidates'
      )
      .mockResolvedValue([
        { id: 'old-session-id', filePath: '/tmp/old.jsonl', mtimeMs: Date.now() - 20_000 },
        { id: 'new-session-id', filePath: '/tmp/new.jsonl', mtimeMs: Date.now() - 10_000 },
        { id: 'another-session', filePath: '/tmp/another.jsonl', mtimeMs: Date.now() }
      ]);
    vi.spyOn(
      manager as unknown as {
        readSessionPreview(filePath: string): Promise<string>;
      },
      'readSessionPreview'
    ).mockResolvedValue('preview');

    const result = await manager.refreshCodexSessionId('wt-1', 'new-session-id');

    expect(result).toBe('new-session-id');
    expect(collectSpy).toHaveBeenCalled();
    expect(store.patchSession).toHaveBeenCalledWith(expect.any(String), { codexSessionId: 'new-session-id' });
  });

  it('clears persisted ids when requested', async () => {
    const store = createStore();
    const manager = new CodexSessionManager(store as unknown as ProjectStore);
    const collectSpy = vi
      .spyOn(
        manager as unknown as {
          collectCodexSessionCandidates(
            root: string,
            cwd: string,
            sessionStart: number,
            lookback: number
          ): Promise<Array<{ id: string; filePath: string; mtimeMs: number }>>;
        },
        'collectCodexSessionCandidates'
      )
      .mockResolvedValue([
        { id: 'old-session-id', filePath: '/tmp/old.jsonl', mtimeMs: Date.now() - 20_000 },
        { id: 'new-session-id', filePath: '/tmp/new.jsonl', mtimeMs: Date.now() - 10_000 },
        { id: 'another-session', filePath: '/tmp/another.jsonl', mtimeMs: Date.now() }
      ]);
    vi.spyOn(
      manager as unknown as {
        readSessionPreview(filePath: string): Promise<string>;
      },
      'readSessionPreview'
    ).mockResolvedValue('preview');

    const result = await manager.refreshCodexSessionId('wt-1', null);

    expect(result).toBeNull();
    expect(collectSpy).toHaveBeenCalled();
    expect(store.patchSession).toHaveBeenCalledWith(expect.any(String), { codexSessionId: undefined });
  });
});
