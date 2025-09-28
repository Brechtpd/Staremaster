import React from 'react';
import { render, waitFor, screen, act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodexTerminalShellPane } from '../../../src/renderer/components/CodexTerminalShellPane';
import type { RendererApi } from '../../../src/shared/api';
import type { WorktreeDescriptor, TerminalOutputPayload } from '../../../src/shared/ipc';
import type { DerivedCodexSession } from '../../../src/renderer/codex-model';

vi.mock('../../../src/renderer/components/CodexTerminal', () => {
  const MockTerminal = React.forwardRef(
    (
      _props: {
        onData: (data: string) => void;
        instanceId: string;
        onResize?: (size: { cols: number; rows: number }) => void;
        onScroll?: (state: { position: number; atBottom: boolean }) => void;
      },
      ref
    ) => {
      React.useImperativeHandle(ref, () => ({
        write: () => {},
        clear: () => {},
        focus: () => {},
        setStdinDisabled: () => {},
        refreshLayout: () => {},
        forceRender: () => {},
        getScrollPosition: () => 0,
        isScrolledToBottom: () => true,
        scrollToLine: () => {},
        scrollToBottom: () => {},
        scrollLines: () => {}
      }));
      return <div data-testid="mock-codex-terminal" />;
    }
  );
  MockTerminal.displayName = 'MockCodexTerminal';
  return { CodexTerminal: MockTerminal };
});

const baseWorktree: WorktreeDescriptor = {
  id: 'wt-1',
  projectId: 'proj-1',
  featureName: 'alpha',
  branch: 'alpha',
  path: '/tmp/proj-1-alpha',
  createdAt: new Date().toISOString(),
  status: 'ready',
  codexStatus: 'running'
};

const createRendererApi = () => {
  const startWorktreeTerminal = vi.fn(async (_id: string, options?: { startupCommand?: string; paneId?: string }) => ({
    sessionId: 'codex-term-1',
    worktreeId: baseWorktree.id,
    shell: '/bin/bash',
    pid: 123,
    startedAt: new Date().toISOString(),
    status: 'running' as const,
    paneId: options?.paneId
  }));
  const refreshCodexSessionId = vi.fn(async () => null);
  const getTerminalSnapshot = vi.fn(async () => ({ content: '', lastEventId: 0 }));
  const getTerminalDelta = vi.fn(async () => ({ chunks: [], lastEventId: 0 }));
  let lastTerminalExitHandler: ((payload: { worktreeId: string; sessionId: string; exitCode: number | null; signal: string | null }) => void) | null =
    null;
  let lastTerminalOutputHandler: ((payload: TerminalOutputPayload) => void) | null = null;

  const api = {
    startWorktreeTerminal,
    stopWorktreeTerminal: vi.fn(async () => {}),
    sendTerminalInput: vi.fn(async () => {}),
    resizeTerminal: vi.fn(async () => {}),
    getTerminalSnapshot,
    getTerminalDelta,
    onTerminalOutput: vi.fn((handler: (payload: TerminalOutputPayload) => void) => {
      lastTerminalOutputHandler = handler;
      return () => {
        if (lastTerminalOutputHandler === handler) {
          lastTerminalOutputHandler = null;
        }
      };
    }),
    onTerminalExit: vi.fn((handler: (payload: { worktreeId: string; sessionId: string; exitCode: number | null; signal: string | null }) => void) => {
      lastTerminalExitHandler = handler;
      return () => {
        if (lastTerminalExitHandler === handler) {
          lastTerminalExitHandler = null;
        }
      };
    }),
    refreshCodexSessionId,
    listCodexSessions: vi.fn(async () => []),
    removeProject: vi.fn(),
    getState: vi.fn(),
    addProject: vi.fn(),
    createWorktree: vi.fn(),
    mergeWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    openWorktreeInVSCode: vi.fn(),
    openWorktreeInGitGui: vi.fn(),
    openWorktreeInFileManager: vi.fn(),
    startCodex: vi.fn(),
    stopCodex: vi.fn(),
    sendCodexInput: vi.fn(),
    onStateUpdate: vi.fn(() => () => {}),
    onCodexOutput: vi.fn(() => () => {}),
    onCodexStatus: vi.fn(() => () => {}),
    getGitStatus: vi.fn(),
    getGitDiff: vi.fn(),
    getCodexLog: vi.fn(),
    summarizeCodexOutput: vi.fn(async () => '')
  } as unknown as RendererApi;

  return {
    api,
    startWorktreeTerminal,
    refreshCodexSessionId,
    getTerminalSnapshot,
    getTerminalDelta,
    getLastExitHandler: () => lastTerminalExitHandler,
    emitTerminalOutput: (payload: TerminalOutputPayload) => lastTerminalOutputHandler?.(payload)
  };
};

describe('CodexTerminalShellPane', () => {
  it('uses the Codex session id for startup commands', async () => {
    const { api, startWorktreeTerminal } = createRendererApi();
    const session: DerivedCodexSession = {
      status: 'running',
      signature: 'session-with-id',
      codexSessionId: 'real-codex-id'
    };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={baseWorktree}
        sessionWorktreeId={baseWorktree.id}
        session={session}
        active
        visible
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(startWorktreeTerminal).toHaveBeenCalled());
    const call = startWorktreeTerminal.mock.calls[0];
    expect(call?.[1]?.startupCommand).toBe('codex resume --yolo real-codex-id');
  });

  it('refreshes the session id when none is available', async () => {
    const { api, refreshCodexSessionId } = createRendererApi();
    (api.listCodexSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={baseWorktree}
        sessionWorktreeId={baseWorktree.id}
        session={undefined}
        active
        visible
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(refreshCodexSessionId).toHaveBeenCalledWith(baseWorktree.id));
  });

  it('lets users rescan the session id', async () => {
    const { api, refreshCodexSessionId } = createRendererApi();
    (api.listCodexSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'fresh-session-id', mtimeMs: Date.now() }
    ]);
    refreshCodexSessionId.mockResolvedValue('fresh-session-id');
    const session: DerivedCodexSession = {
      status: 'running',
      signature: 'session-running',
      codexSessionId: 'cached-session'
    };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={baseWorktree}
        sessionWorktreeId={baseWorktree.id}
        session={session}
        active
        visible
        onNotification={() => {}}
      />
    );

    refreshCodexSessionId.mockClear();
    const rescanButton = await screen.findByRole('button', { name: 'Switch Session' });
    await act(async () => {
      fireEvent.click(rescanButton);
    });
    await waitFor(() => expect(api.listCodexSessions).toHaveBeenCalledWith(baseWorktree.id));
    const confirm = await screen.findByRole('button', { name: 'Use Selected Session' });
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(refreshCodexSessionId).toHaveBeenCalledWith(baseWorktree.id, 'fresh-session-id'));
  });

  it('refreshes the session id when the terminal exits', async () => {
    const { api, refreshCodexSessionId, getLastExitHandler } = createRendererApi();
    (api.listCodexSessions as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={baseWorktree}
        sessionWorktreeId={baseWorktree.id}
        session={undefined}
        active
        visible
        onNotification={() => {}}
      />
    );

    const exitHandler = getLastExitHandler();
    expect(exitHandler).toBeDefined();
    refreshCodexSessionId.mockClear();
    await act(async () => {
      exitHandler?.({ worktreeId: baseWorktree.id, sessionId: 'codex-term-1', exitCode: 0, signal: null });
    });
    await waitFor(() => expect(refreshCodexSessionId).toHaveBeenCalledWith(baseWorktree.id));
  });
});
