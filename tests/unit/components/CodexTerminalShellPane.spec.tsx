import React from 'react';
import { act, render, waitFor, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodexTerminalShellPane } from '../../../src/renderer/components/CodexTerminalShellPane';
import type { RendererApi } from '../../../src/shared/api';
import type { WorktreeDescriptor, WorktreeTerminalDescriptor } from '../../../src/shared/ipc';
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
  const startCodexTerminal = vi.fn(async (_worktreeId: string, options?: { startupCommand?: string; paneId?: string }) => ({
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
  const getCodexTerminalSnapshot = vi.fn(async () => ({ content: '', lastEventId: 0 }));
  const getCodexTerminalDelta = vi.fn(async () => ({ chunks: [], lastEventId: 0 }));
  let lastCodexTerminalExitHandler: ((payload: {
    worktreeId: string;
    sessionId: string;
    exitCode: number | null;
    signal: string | null;
  }) => void) | null = null;

  const api = {
    startCodexTerminal,
    stopCodexTerminal: vi.fn(async () => {}),
    sendCodexTerminalInput: vi.fn(async () => {}),
    resizeCodexTerminal: vi.fn(async () => {}),
    getCodexTerminalSnapshot,
    getCodexTerminalDelta,
    onCodexTerminalOutput: vi.fn(() => () => {}),
    onCodexTerminalExit: vi.fn((handler: (payload: { worktreeId: string; sessionId: string; exitCode: number | null; signal: string | null }) => void) => {
      lastCodexTerminalExitHandler = handler;
      return () => {};
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
    summarizeCodexOutput: vi.fn(async () => ''),
    startWorktreeTerminal: vi.fn(),
    stopWorktreeTerminal: vi.fn(),
    sendTerminalInput: vi.fn(),
    resizeTerminal: vi.fn(),
    getTerminalSnapshot: vi.fn(async () => ({ content: '', lastEventId: 0 })),
    getTerminalDelta: vi.fn(async () => ({ chunks: [], lastEventId: 0 })),
    onTerminalOutput: vi.fn(() => () => {}),
    onTerminalExit: vi.fn(() => () => {})
  } as unknown as RendererApi;

  return {
    api,
    startCodexTerminal,
    setCodexResumeCommand,
    refreshCodexResumeCommand,
    getCodexTerminalSnapshot,
    getCodexTerminalDelta,
    getLastExitHandler: () => lastCodexTerminalExitHandler
  };
};

describe('CodexTerminalShellPane', () => {
  it('does not persist resume command when only an internal session id is present', async () => {
    const {
      api,
      startCodexTerminal,
      setCodexResumeCommand,
      refreshCodexResumeCommand,
      getCodexTerminalSnapshot
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
        sessionWorktreeId={worktree.id}
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(getCodexTerminalSnapshot).toHaveBeenCalled());
    await waitFor(() => expect(startCodexTerminal).toHaveBeenCalled());

    const call = startCodexTerminal.mock.calls[0];
    expect(call[1]?.startupCommand).toBe('codex resume --yolo cached-id');
    await waitFor(() => expect(refreshCodexResumeCommand).toHaveBeenCalledTimes(1));
    expect(setCodexResumeCommand).not.toHaveBeenCalled();
  });

  it('persists resume command when a real Codex session id is available', async () => {
    const {
      api,
      startCodexTerminal,
      setCodexResumeCommand,
      refreshCodexResumeCommand,
      getCodexTerminalSnapshot
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
        sessionWorktreeId={worktree.id}
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(getCodexTerminalSnapshot).toHaveBeenCalled());
    await waitFor(() => expect(startCodexTerminal).toHaveBeenCalled());

    await waitFor(() => expect(setCodexResumeCommand).toHaveBeenCalledTimes(1));
    expect(setCodexResumeCommand).toHaveBeenCalledWith(worktree.id, 'codex resume --yolo real-codex-id');
    expect(refreshCodexResumeCommand).toHaveBeenCalledTimes(1);

    const call = startCodexTerminal.mock.calls[0];
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
        sessionWorktreeId="wt-main"
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(refreshCodexResumeCommand).toHaveBeenCalledWith('wt-main'));
    await waitFor(() => expect(setCodexResumeCommand).toHaveBeenCalledTimes(2));

    const ids = setCodexResumeCommand.mock.calls.map((call) => call[0]);
    expect(ids).toContain('wt-main');
    expect(ids).toContain('project-root:proj-1');

    const payloads = setCodexResumeCommand.mock.calls.map((call) => call[1]);
    expect(new Set(payloads)).toEqual(new Set(['codex resume --yolo proj-root']));
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
        sessionWorktreeId="wt-main"
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(refreshCodexResumeCommand).toHaveBeenCalledWith('wt-main'));
    await waitFor(() => expect(setCodexResumeCommand).toHaveBeenCalledTimes(2));
    expect(setCodexResumeCommand).toHaveBeenCalledWith('wt-main', 'codex resume --yolo cached-project-root');
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
        sessionWorktreeId={worktree.id}
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(screen.getByText(/Session ID:\s*abc-123/)).toBeInTheDocument());
  });

  it('clears a stale resume command and falls back to a fresh session when the resume exits with error', async () => {
    const {
      api,
      startCodexTerminal,
      setCodexResumeCommand,
      refreshCodexResumeCommand,
      getCodexTerminalSnapshot,
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
        sessionWorktreeId={worktree.id}
        onNotification={() => {}}
        onUnbootstrapped={() => {}}
      />
    );

    await waitFor(() => expect(getCodexTerminalSnapshot).toHaveBeenCalled());
    await waitFor(() => expect(startCodexTerminal).toHaveBeenCalledTimes(1));

    const exitHandler = getLastExitHandler();
    expect(exitHandler).toBeTruthy();
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
    await waitFor(() => expect(startCodexTerminal).toHaveBeenCalledTimes(2));
    const fallbackCall = startCodexTerminal.mock.calls[1];
    expect(fallbackCall[1]?.startupCommand).toBe('codex --yolo');
  });

  it('marks the pane as unbootstrapped and restarts on a clean exit when visible', async () => {
    const { api, startCodexTerminal, getCodexTerminalSnapshot, getLastExitHandler } = createRendererApi();
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
        sessionWorktreeId={worktree.id}
        onNotification={() => {}}
        onUnbootstrapped={onUnbootstrapped}
      />
    );

    await waitFor(() => expect(getCodexTerminalSnapshot).toHaveBeenCalled());
    await waitFor(() => expect(startCodexTerminal).toHaveBeenCalledTimes(1));

    const exitHandler = getLastExitHandler();
    expect(exitHandler).toBeTruthy();

    await act(async () => {
      exitHandler!({
        worktreeId: worktree.id,
        sessionId: 'codex-term-1',
        exitCode: 0,
        signal: null
      });
    });

    expect(onUnbootstrapped).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(startCodexTerminal).toHaveBeenCalledTimes(2));
  });

  it('captures resume command emitted before the terminal start resolves, including hyperlink formatting', async () => {
    const { api, startCodexTerminal, setCodexResumeCommand, getCodexTerminalSnapshot } = createRendererApi();

    let resolveStart: (descriptor: WorktreeTerminalDescriptor) => void;
    startCodexTerminal.mockImplementation(async () => {
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
        sessionWorktreeId={worktree.id}
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(getCodexTerminalSnapshot).toHaveBeenCalled());
    const outputHandler = api.onCodexTerminalOutput.mock.calls[0]?.[0];
    expect(outputHandler).toBeTruthy();

    const hyperlinkChunk = `\u001B]8;;https://example.com\u0007codex resume --yolo deadbeef-dead-beef-dead-beefdeadbeef\u001B\\`;

    act(() => {
      outputHandler!({
        worktreeId: worktree.id,
        sessionId: 'pending-session',
        chunk: hyperlinkChunk,
        paneId: 'pane-early',
        eventId: 1
      });
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
      startCodexTerminal,
      getCodexTerminalSnapshot,
      getCodexTerminalDelta
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
        sessionWorktreeId={worktree.id}
        onNotification={() => {}}
      />
    );

    await waitFor(() => {
      expect(startCodexTerminal).toHaveBeenCalledWith(worktree.id, expect.objectContaining({ paneId: 'pane-multi' }));
    });

    await waitFor(() => {
      expect(getCodexTerminalSnapshot).toHaveBeenCalledWith(worktree.id, { paneId: 'pane-multi' });
    });

    const outputHandler = api.onCodexTerminalOutput.mock.calls[0]?.[0];
    expect(outputHandler).toBeTruthy();

    const initialDeltaCalls = getCodexTerminalDelta.mock.calls.length;

    act(() => {
      outputHandler!({
        worktreeId: worktree.id,
        sessionId: 'codex-term-ignore',
        paneId: 'other-pane',
        chunk: 'ignored-output',
        eventId: 1
      });
    });

    expect(getCodexTerminalDelta.mock.calls.length).toBe(initialDeltaCalls);

    act(() => {
      outputHandler!({
        worktreeId: worktree.id,
        sessionId: 'codex-term-1',
        paneId: 'pane-multi',
        chunk: 'trigger delta',
        eventId: 5
      });
    });

    await waitFor(() => {
      expect(getCodexTerminalDelta).toHaveBeenCalledWith(worktree.id, 0, { paneId: 'pane-multi' });
    });
  });
});
