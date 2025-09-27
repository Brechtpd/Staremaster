import React from 'react';
import { act, render, waitFor, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodexTerminalShellPane } from '../../../src/renderer/components/CodexTerminalShellPane';
import type { RendererApi } from '../../../src/shared/api';
import type { WorktreeDescriptor, WorktreeTerminalDescriptor, TerminalOutputPayload } from '../../../src/shared/ipc';
import type { DerivedCodexSession } from '../../../src/renderer/codex-model';

vi.mock('../../../src/renderer/components/CodexTerminal', () => {
  const MockTerminal = React.forwardRef((_props: { onData: (data: string) => void }, ref) => {
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
      scrollToBottom: () => {}
    }));
    return <div data-testid="mock-codex-terminal" />;
  });
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
  const startWorktreeTerminal = vi.fn(async (_worktreeId: string, options?: { startupCommand?: string; paneId?: string }) => ({
    sessionId: 'codex-term-1',
    worktreeId: baseWorktree.id,
    shell: '/bin/bash',
    pid: 123,
    startedAt: new Date().toISOString(),
    status: 'running' as const,
    paneId: options?.paneId
  }));
  const setCodexResumeCommand = vi.fn(async () => {});
  const refreshCodexResumeCommand = vi.fn(async () => null);
  const refreshCodexResumeFromLogs = vi.fn(async () => {});
  const getTerminalSnapshot = vi.fn(async () => ({ content: '', lastEventId: 0 }));
  const getTerminalDelta = vi.fn(async () => ({ chunks: [], lastEventId: 0 }));
  let lastTerminalExitHandler: ((payload: {
    worktreeId: string;
    sessionId: string;
    exitCode: number | null;
    signal: string | null;
  }) => void) | null = null;
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
    setCodexResumeCommand,
    refreshCodexResumeCommand,
    refreshCodexResumeFromLogs,
    removeProject: vi.fn(),
    // Unused API surface mocked for type completeness.
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
    setCodexResumeCommand,
    refreshCodexResumeCommand,
    getTerminalSnapshot,
    getTerminalDelta,
    getLastExitHandler: () => lastTerminalExitHandler,
    emitTerminalOutput: (payload: TerminalOutputPayload) => lastTerminalOutputHandler?.(payload)
  };
};

describe('CodexTerminalShellPane', () => {
  it('does not persist resume command when only an internal session id is present', async () => {
    const {
      api,
      startWorktreeTerminal,
      setCodexResumeCommand,
      refreshCodexResumeCommand,
      getTerminalSnapshot
    } = createRendererApi();
    const worktree: WorktreeDescriptor = {
      ...baseWorktree,
      codexResumeCommand: 'codex resume --yolo cached-id'
    };

    const session: DerivedCodexSession = {
      status: 'running',
      signature: 'session-internal',
      sessionId: 'internal-only'
    };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={session}
        paneId="pane-1"
        active
        visible
        onNotification={() => {}}
      />
    );

    // No initial hydration at start; we rely on Codex resume output only.
    await waitFor(() => expect(startWorktreeTerminal).toHaveBeenCalled());

    const call = startWorktreeTerminal.mock.calls[0];
    expect(call[1]?.startupCommand).toBe('codex resume --yolo cached-id');
    await waitFor(() => expect(refreshCodexResumeCommand).toHaveBeenCalledTimes(1));
    expect(setCodexResumeCommand).toHaveBeenCalledWith('wt-1', 'codex resume --yolo cached-id');
  });

  it('persists resume command when a real Codex session id is available', async () => {
    const {
      api,
      startWorktreeTerminal,
      setCodexResumeCommand,
      refreshCodexResumeCommand,
      getTerminalSnapshot
    } = createRendererApi();
    const worktree: WorktreeDescriptor = { ...baseWorktree };

    const session: DerivedCodexSession = {
      status: 'running',
      signature: 'session-with-codex-id',
      sessionId: 'internal-value',
      codexSessionId: 'real-codex-id'
    };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={session}
        paneId="pane-2"
        active
        visible
        onNotification={() => {}}
      />
    );

    // No start-time hydrate; rely on resume
    await waitFor(() => expect(startWorktreeTerminal).toHaveBeenCalled());

    await waitFor(() => expect(setCodexResumeCommand).toHaveBeenCalledTimes(1));
    expect(setCodexResumeCommand).toHaveBeenCalledWith(worktree.id, 'codex resume --yolo real-codex-id');
    expect(refreshCodexResumeCommand).toHaveBeenCalledTimes(1);

    const call = startWorktreeTerminal.mock.calls[0];
    expect(call[1]?.startupCommand).toBe('codex resume --yolo real-codex-id');
  });

  it('syncs refreshed resume command back to the project-root alias', async () => {
    const {
      api,
      refreshCodexResumeCommand,
      setCodexResumeCommand
    } = createRendererApi();

    refreshCodexResumeCommand.mockResolvedValueOnce('codex resume --yolo proj-root');

    const worktree: WorktreeDescriptor = {
      ...baseWorktree,
      id: 'project-root:proj-1',
      codexStatus: 'idle'
    };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        paneId="pane-3"
        active
        visible
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(refreshCodexResumeCommand).toHaveBeenCalledWith('project-root:proj-1'));
    await waitFor(() => expect(setCodexResumeCommand).toHaveBeenCalledTimes(1));

    expect(setCodexResumeCommand).toHaveBeenCalledWith('project-root:proj-1', 'codex resume --yolo proj-root');
  });

  it('replays the stored project-root resume command when the canonical worktree lacks one', async () => {
    const {
      api,
      refreshCodexResumeCommand,
      setCodexResumeCommand
    } = createRendererApi();

    refreshCodexResumeCommand.mockResolvedValueOnce(null);

    const worktree: WorktreeDescriptor = {
      ...baseWorktree,
      id: 'project-root:proj-1',
      codexStatus: 'idle',
      codexResumeCommand: 'codex resume --yolo cached-project-root'
    };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        paneId="pane-4"
        active
        visible
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(refreshCodexResumeCommand).toHaveBeenCalledWith('project-root:proj-1'));
    await waitFor(() => expect(setCodexResumeCommand).toHaveBeenCalledTimes(1));
    expect(setCodexResumeCommand).toHaveBeenCalledWith('project-root:proj-1', 'codex resume --yolo cached-project-root');
  });

  it('derives the session id from stored commands with alternate flags', async () => {
    const { api } = createRendererApi();

    const worktree: WorktreeDescriptor = {
      ...baseWorktree,
      codexResumeCommand: 'codex resume --session-id=abc-123 --resume-mode fast'
    };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        active
        visible
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(screen.getByText(/Session ID:\s*abc-123/)).toBeInTheDocument());
  });

  it('clears a stale resume command and falls back to a fresh session when the resume exits with error', async () => {
    const {
      api,
      startWorktreeTerminal,
      setCodexResumeCommand,
      refreshCodexResumeCommand,
      getTerminalSnapshot,
      getLastExitHandler
    } = createRendererApi();
    const worktree: WorktreeDescriptor = {
      ...baseWorktree,
      codexResumeCommand: 'codex resume --yolo stale-id'
    };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        paneId="pane-3"
        active
        visible
        onNotification={() => {}}
        onUnbootstrapped={() => {}}
      />
    );

    // No start-time hydrate; rely on resume
    await waitFor(() => expect(startWorktreeTerminal).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getLastExitHandler()).toBeTruthy());

    const exitHandler = getLastExitHandler();
    await act(async () => {
      exitHandler!({
        worktreeId: worktree.id,
        sessionId: 'codex-term-1',
        exitCode: 1,
        signal: null
      });
    });

    await waitFor(() => expect(refreshCodexResumeCommand).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(setCodexResumeCommand).toHaveBeenCalledWith(worktree.id, null));
    await waitFor(() => expect(startWorktreeTerminal).toHaveBeenCalledTimes(2));
    const fallbackCall = startWorktreeTerminal.mock.calls[1];
    expect(fallbackCall[1]?.startupCommand).toBe('codex --yolo');
  });

  it('marks the pane as unbootstrapped and restarts on a clean exit when visible', async () => {
    const { api, startWorktreeTerminal, getLastExitHandler } = createRendererApi();
    const worktree: WorktreeDescriptor = { ...baseWorktree };
    const onUnbootstrapped = vi.fn();

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        paneId="pane-clean-exit"
        active
        visible
        onNotification={() => {}}
        onUnbootstrapped={onUnbootstrapped}
      />
    );

    // No start-time hydrate; rely on resume
    await waitFor(() => expect(startWorktreeTerminal).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getLastExitHandler()).toBeTruthy());

    const exitHandler = getLastExitHandler();

    await act(async () => {
      exitHandler!({
        worktreeId: worktree.id,
        sessionId: 'codex-term-1',
        exitCode: 0,
        signal: null
      });
    });

    expect(onUnbootstrapped).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(startWorktreeTerminal).toHaveBeenCalledTimes(2));
  });

  it('captures resume command emitted before the terminal start resolves, including hyperlink formatting', async () => {
    const { api, startWorktreeTerminal, setCodexResumeCommand, emitTerminalOutput } = createRendererApi();

    let resolveStart: (descriptor: WorktreeTerminalDescriptor) => void;
    startWorktreeTerminal.mockImplementation(async () => {
      return await new Promise<WorktreeTerminalDescriptor>((resolve) => {
        resolveStart = (descriptor) => resolve(descriptor);
      });
    });

    const worktree: WorktreeDescriptor = { ...baseWorktree };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        paneId="pane-early"
        active
        visible
        onNotification={() => {}}
      />
    );

    // No start-time hydrate; rely on resume
    const hyperlinkChunk = `\u001B]8;;https://example.com\u0007codex resume --yolo deadbeef-dead-beef-dead-beefdeadbeef\u001B\\`;

    act(() => {
      emitTerminalOutput({
        worktreeId: worktree.id,
        sessionId: 'pending-session',
        chunk: hyperlinkChunk,
        paneId: 'pane-early',
        eventId: 1
      } as TerminalOutputPayload);
    });

    await waitFor(() =>
      expect(setCodexResumeCommand).toHaveBeenCalledWith(
        worktree.id,
        'codex resume --yolo deadbeef-dead-beef-dead-beefdeadbeef'
      )
    );

    await act(async () => {
      resolveStart!({
        sessionId: 'codex-term-1',
        worktreeId: worktree.id,
        shell: '/bin/bash',
        pid: 123,
        startedAt: new Date().toISOString(),
        status: 'running'
      });
    });
  });

  it('scopes lifecycle calls to the active pane id when multiple terminal panes exist', async () => {
    const {
      api,
      startWorktreeTerminal,
      getTerminalSnapshot,
      getTerminalDelta,
      emitTerminalOutput
    } = createRendererApi();

    const worktree: WorktreeDescriptor = { ...baseWorktree };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        paneId="pane-multi"
        active
        visible
        onNotification={() => {}}
      />
    );

    await waitFor(() => {
      expect(startWorktreeTerminal).toHaveBeenCalledWith(worktree.id, expect.objectContaining({ paneId: 'pane-multi' }));
    });

    // No initial hydration at start; snapshot should not be called here.

    await waitFor(() => expect(api.onTerminalOutput).toHaveBeenCalled());

    const initialDeltaCalls = getTerminalDelta.mock.calls.length;

    act(() => {
      emitTerminalOutput({
        worktreeId: worktree.id,
        sessionId: 'codex-term-ignore',
        paneId: 'other-pane',
        chunk: 'ignored-output',
        eventId: 1
      } as TerminalOutputPayload);
    });

    expect(getTerminalDelta.mock.calls.length).toBe(initialDeltaCalls);

    act(() => {
      emitTerminalOutput({
        worktreeId: worktree.id,
        sessionId: 'codex-term-1',
        paneId: 'pane-multi',
        chunk: 'trigger delta',
        eventId: 5
      } as TerminalOutputPayload);
    });

    await waitFor(() => {
      expect(getTerminalDelta).toHaveBeenCalledWith(worktree.id, 0, { paneId: 'pane-multi' });
    });
  });

  it('ignores output without paneId when pane has an id (strict filtering)', async () => {
    const { api, startWorktreeTerminal, getTerminalDelta, emitTerminalOutput } = createRendererApi();

    const worktree: WorktreeDescriptor = { ...baseWorktree };

    render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        paneId="pane-strict"
        active
        visible
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(startWorktreeTerminal).toHaveBeenCalled());

    const initialDeltaCalls = (getTerminalDelta as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    act(() => {
      emitTerminalOutput({
        worktreeId: worktree.id,
        sessionId: 'codex-term-1',
        // no paneId provided
        chunk: 'should be ignored',
        eventId: 5
      } as unknown as TerminalOutputPayload);
    });

    expect((getTerminalDelta as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(initialDeltaCalls);
  });

  it('catches up via delta after live output arrives while invisible (no snapshot hydration)', async () => {
    const {
      api,
      startWorktreeTerminal,
      getTerminalSnapshot,
      getTerminalDelta,
      emitTerminalOutput
    } = createRendererApi();

    // Delay snapshot to simulate hydration window
    let resolveSnapshot: ((value: { content: string; lastEventId: number }) => void) | null = null;
    getTerminalSnapshot.mockImplementation(
      async () =>
        await new Promise<{ content: string; lastEventId: number }>((resolve) => {
          resolveSnapshot = resolve;
        })
    );

    // Prepare delta to return the missed chunk
    getTerminalDelta.mockResolvedValueOnce({
      chunks: [{ id: 1, data: 'missed' }],
      lastEventId: 1
    });

    const worktree: WorktreeDescriptor = { ...baseWorktree };

    const { rerender } = render(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        paneId="pane-hydrate"
        active
        visible
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(startWorktreeTerminal).toHaveBeenCalled());

    // Become invisible and receive live output while hidden
    rerender(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        paneId="pane-hydrate"
        active
        visible={false}
        onNotification={() => {}}
      />
    );

    act(() => {
      emitTerminalOutput({
        worktreeId: worktree.id,
        sessionId: 'codex-term-1',
        paneId: 'pane-hydrate',
        chunk: 'live-while-hydrating',
        eventId: 1
      } as TerminalOutputPayload);
    });

    // Become visible again -> should call delta to catch up
    rerender(
      <CodexTerminalShellPane
        api={api}
        worktree={worktree}
        session={undefined}
        paneId="pane-hydrate"
        active
        visible
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(getTerminalDelta).toHaveBeenCalled());
  });
});
