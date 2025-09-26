import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
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
    onCodexTerminalOutput: vi.fn(() => () => {}),
    onCodexTerminalExit: vi.fn((handler: (payload: { worktreeId: string; sessionId: string; exitCode: number | null; signal: string | null }) => void) => {
      lastCodexTerminalExitHandler = handler;
      return () => {};
    }),
    setCodexResumeCommand,
    refreshCodexResumeCommand,
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
    onTerminalOutput: vi.fn(() => () => {}),
    onTerminalExit: vi.fn(() => () => {})
  } as unknown as RendererApi;

  return {
    api,
    startCodexTerminal,
    setCodexResumeCommand,
    refreshCodexResumeCommand,
    getLastExitHandler: () => lastCodexTerminalExitHandler
  };
};

describe('CodexTerminalShellPane', () => {
  it('does not persist resume command when only an internal session id is present', async () => {
    const { api, startCodexTerminal, setCodexResumeCommand, refreshCodexResumeCommand } = createRendererApi();
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
        shouldAutoStart
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(startCodexTerminal).toHaveBeenCalled());

    const call = startCodexTerminal.mock.calls[0];
    expect(call[1]?.startupCommand).toBe('codex resume --yolo cached-id');
    expect(setCodexResumeCommand).not.toHaveBeenCalled();
    expect(refreshCodexResumeCommand).toHaveBeenCalledTimes(1);
  });

  it('persists resume command when a real Codex session id is available', async () => {
    const { api, startCodexTerminal, setCodexResumeCommand, refreshCodexResumeCommand } = createRendererApi();
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
        shouldAutoStart
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(startCodexTerminal).toHaveBeenCalled());

    await waitFor(() => expect(setCodexResumeCommand).toHaveBeenCalledTimes(1));
    expect(setCodexResumeCommand).toHaveBeenCalledWith(worktree.id, 'codex resume --yolo real-codex-id');
    expect(refreshCodexResumeCommand).toHaveBeenCalledTimes(1);

    const call = startCodexTerminal.mock.calls[0];
    expect(call[1]?.startupCommand).toBe('codex resume --yolo real-codex-id');
  });

  it('clears a stale resume command and falls back to a fresh session when the resume exits with error', async () => {
    const { api, startCodexTerminal, setCodexResumeCommand, refreshCodexResumeCommand, getLastExitHandler } = createRendererApi();
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
        shouldAutoStart
        onNotification={() => {}}
      />
    );

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

  it('captures resume command emitted before the terminal start resolves, including hyperlink formatting', async () => {
    const { api, startCodexTerminal, setCodexResumeCommand } = createRendererApi();

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
        shouldAutoStart
        onNotification={() => {}}
      />
    );

    const outputHandler = api.onCodexTerminalOutput.mock.calls[0]?.[0];
    expect(outputHandler).toBeTruthy();

    const hyperlinkChunk = `\u001B]8;;https://example.com\u0007codex resume --yolo deadbeef-dead-beef-dead-beefdeadbeef\u001B\\`;

    act(() => {
      outputHandler!({
        worktreeId: worktree.id,
        sessionId: 'pending-session',
        chunk: hyperlinkChunk
      });
    });

    expect(setCodexResumeCommand).toHaveBeenCalledWith(
      worktree.id,
      'codex resume --yolo deadbeef-dead-beef-dead-beefdeadbeef'
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
});
