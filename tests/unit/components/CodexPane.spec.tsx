import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { CodexPane } from '../../../src/renderer/components/CodexPane';
import type { RendererApi } from '../../../src/shared/api';
import type { WorktreeDescriptor } from '../../../src/shared/ipc';
import type { DerivedCodexSession } from '../../../src/renderer/codex-model';

type TestIdleCallback = (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void;

const baseWorktree: WorktreeDescriptor = {
  id: 'project-root:proj-1',
  projectId: 'proj-1',
  featureName: 'main',
  branch: 'main',
  path: '/tmp/proj-1',
  createdAt: new Date().toISOString(),
  status: 'ready',
  codexStatus: 'idle'
};

const idleWindow = window as typeof window & {
  requestIdleCallback?: (callback: TestIdleCallback) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const originalRequestIdleCallback = idleWindow.requestIdleCallback;
const originalCancelIdleCallback = idleWindow.cancelIdleCallback;

beforeAll(() => {
  let nextHandle = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  idleWindow.requestIdleCallback = (callback) => {
    const handle = nextHandle++;
    const timer = setTimeout(() => {
      callback({ didTimeout: false, timeRemaining: () => 1 });
      timers.delete(handle);
    }, 0);
    timers.set(handle, timer);
    return handle;
  };

  idleWindow.cancelIdleCallback = (handle) => {
    const timer = timers.get(handle);
    if (timer) {
      clearTimeout(timer);
      timers.delete(handle);
    }
  };
});

afterAll(() => {
  idleWindow.requestIdleCallback = originalRequestIdleCallback;
  idleWindow.cancelIdleCallback = originalCancelIdleCallback;
});

let lastOnData: ((data: string) => void) | null = null;
vi.mock('../../../src/renderer/components/CodexTerminal', () => {
  const MockTerminal = React.forwardRef(
    (
      props: {
        onData: (data: string) => void;
        instanceId: string;
        onResize?: (size: { cols: number; rows: number }) => void;
        onScroll?: (state: { position: number; atBottom: boolean }) => void;
      },
      ref: React.Ref<unknown>
    ) => {
      const handle = {
        write: vi.fn(),
        clear: vi.fn(),
        focus: vi.fn(),
        setStdinDisabled: vi.fn(),
        refreshLayout: vi.fn(),
        scrollToBottom: vi.fn(),
        scrollToLine: vi.fn(),
        getScrollPosition: vi.fn(() => 0),
        scrollLines: vi.fn<(offset: number) => void>()
      };
      React.useImperativeHandle(ref, () => handle);
      lastOnData = props.onData;
      return <div data-testid="mock-codex-terminal" />;
    }
  );
  MockTerminal.displayName = 'MockCodexTerminal';
  return { CodexTerminal: MockTerminal };
});

const createRendererApi = () => {
  const startCodex = vi.fn(async () => ({
    id: 'codex-session-1',
    worktreeId: 'wt-main',
    status: 'running',
    startedAt: new Date().toISOString()
  }));
  const sendCodexInput = vi.fn(async () => {});
  const onCodexOutput = vi.fn(() => () => {});
  const onCodexStatus = vi.fn(() => () => {});
  const getCodexLog = vi.fn(async () => '');

  const api = {
    startCodex,
    stopCodex: vi.fn(),
    sendCodexInput,
    onCodexOutput,
    onCodexStatus,
    getCodexLog,
    removeProject: vi.fn(),
    // Unused Renderer API surface mocked for completeness
    getState: vi.fn(),
    addProject: vi.fn(),
    createWorktree: vi.fn(),
    mergeWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    openWorktreeInVSCode: vi.fn(),
    openWorktreeInGitGui: vi.fn(),
    openWorktreeInFileManager: vi.fn(),
    startWorktreeTerminal: vi.fn(),
    stopWorktreeTerminal: vi.fn(),
    sendTerminalInput: vi.fn(),
    resizeTerminal: vi.fn(),
    getGitStatus: vi.fn(),
    getGitDiff: vi.fn(),
    summarizeCodexOutput: vi.fn(),
    refreshCodexSessionId: vi.fn(async () => null),
    listCodexSessions: vi.fn(async () => []),
    startWorktreeTerminal: vi.fn(),
    stopWorktreeTerminal: vi.fn(),
    sendTerminalInput: vi.fn(),
    resizeTerminal: vi.fn(),
    getTerminalSnapshot: vi.fn(),
    getTerminalDelta: vi.fn(),
    onTerminalOutput: vi.fn(() => () => {}),
    onTerminalExit: vi.fn(() => () => {})
  } as unknown as RendererApi;

  return {
    api,
    startCodex,
    sendCodexInput,
    onCodexOutput,
    onCodexStatus,
    getCodexLog
  };
};

beforeEach(() => {
  lastOnData = null;
});

describe('CodexPane', () => {
  it('starts Codex using the session worktree id for project-root tabs', async () => {
    const { api, startCodex } = createRendererApi();
    const worktree: WorktreeDescriptor = {
      ...baseWorktree,
      codexStatus: 'idle'
    };
    const session: DerivedCodexSession = {
      status: 'idle',
      signature: 'sig-idle',
      codexSessionId: 'cached-session-id'
    };

    render(
      <CodexPane
        api={api}
        bridge={api}
        worktree={worktree}
        sessionWorktreeId="wt-main"
        session={session}
        active
        visible
        paneId="pane-1"
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(startCodex).toHaveBeenCalledTimes(1));
    expect(startCodex).toHaveBeenCalledWith('wt-main');
  });

  it('sends input through the session worktree id when the terminal emits data', async () => {
    const { api, sendCodexInput } = createRendererApi();
    const worktree: WorktreeDescriptor = {
      ...baseWorktree,
      codexStatus: 'running'
    };
    const session: DerivedCodexSession = {
      status: 'running',
      signature: 'sig-running',
      codexSessionId: 'cached-session-id'
    };

    render(
      <CodexPane
        api={api}
        bridge={null}
        worktree={worktree}
        sessionWorktreeId="wt-main"
        session={session}
        active
        visible
        paneId="pane-2"
        onNotification={() => {}}
      />
    );

    expect(lastOnData).toBeTruthy();

    await act(async () => {
      lastOnData?.('ls\n');
    });

    await waitFor(() => expect(sendCodexInput).toHaveBeenCalledTimes(1));
    expect(sendCodexInput).toHaveBeenCalledWith('wt-main', 'ls\n');
  });

  it('hydrates using the session worktree id when resuming without an active session id', async () => {
    const { api, getCodexLog } = createRendererApi();
    getCodexLog.mockResolvedValueOnce('cached output');
    const refreshSessionId = api.refreshCodexSessionId as ReturnType<typeof vi.fn>;
    refreshSessionId.mockResolvedValue('hydrated-session-id');
    const listSessions = api.listCodexSessions as ReturnType<typeof vi.fn>;
    listSessions.mockResolvedValue([]);
    const session: DerivedCodexSession = {
      status: 'idle',
      signature: 'sig-hydrate'
    };

    render(
      <CodexPane
        api={api}
        bridge={api}
        worktree={baseWorktree}
        sessionWorktreeId="wt-main"
        session={session}
        active
        visible
        paneId="pane-3"
        onNotification={() => {}}
      />
    );

    await waitFor(() => expect(getCodexLog).toHaveBeenCalledWith('wt-main'));
    const cancelButton = await screen.findByRole('button', { name: 'Cancel' });
    await act(async () => {
      fireEvent.click(cancelButton);
    });
    await screen.findByText('Session ID: hydrated-session-id');
  });

  it('updates the footer immediately after a manual resume rescan', async () => {
    const { api } = createRendererApi();
    const refreshSessionId = api.refreshCodexSessionId as ReturnType<typeof vi.fn>;
    refreshSessionId.mockResolvedValue('fresh-session-id');
    const listSessions = api.listCodexSessions as ReturnType<typeof vi.fn>;
    listSessions.mockResolvedValue([{ id: 'fresh-session-id', mtimeMs: Date.now() }]);

    const worktree: WorktreeDescriptor = {
      ...baseWorktree
    };

    const session: DerivedCodexSession = {
      status: 'running',
      signature: 'sig-running'
    };

    render(
      <CodexPane
        api={api}
        bridge={null}
        worktree={worktree}
        sessionWorktreeId="wt-main"
        session={session}
        active
        visible
        paneId="pane-rescan"
        onNotification={() => {}}
      />
    );

    const button = screen.getByRole('button', { name: 'Switch Session' });
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(listSessions).toHaveBeenCalledWith('wt-main'));

    const useButton = await screen.findByRole('button', { name: 'Use Selected Session' });
    await act(async () => {
      fireEvent.click(useButton);
    });

    await waitFor(() => expect(refreshSessionId).toHaveBeenCalledWith('wt-main', 'fresh-session-id'));
    await screen.findByText('Resume: codex resume --yolo fresh-session-id');
    await screen.findByText('Session ID: fresh-session-id');
  });
});
