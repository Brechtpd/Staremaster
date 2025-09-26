import React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { RendererApi } from '../../../src/shared/api';
import type {
  TerminalOutputPayload,
  TerminalExitPayload,
  WorktreeDescriptor,
  WorktreeTerminalDescriptor
} from '../../../src/shared/ipc';
import { WorktreeTerminalPane } from '../../../src/renderer/components/WorktreeTerminalPane';

type Listener<T> = (payload: T) => void;

const mockTerminalHandle = {
  write: vi.fn<(data: string) => void>(),
  clear: vi.fn<() => void>(),
  focus: vi.fn<() => void>(),
  setStdinDisabled: vi.fn<(disabled: boolean) => void>(),
  refreshLayout: vi.fn<() => void>(),
  forceRender: vi.fn<() => void>(),
  getScrollPosition: vi.fn(() => 0),
  scrollToLine: vi.fn<(line: number) => void>(),
  scrollToBottom: vi.fn<() => void>()
};

let mockOnData: ((data: string) => void) | null = null;
let mockOnResize: ((size: { cols: number; rows: number }) => void) | null = null;

vi.mock('../../../src/renderer/components/CodexTerminal', async () => {
  const actualReact = await import('react');

  const MockTerminal = actualReact.forwardRef(
    (
      props: { onData: (data: string) => void; instanceId: string; onResize?: (size: { cols: number; rows: number }) => void },
      ref: React.Ref<typeof mockTerminalHandle>
    ) => {
      mockOnData = props.onData;
      mockOnResize = props.onResize ?? null;
      actualReact.useImperativeHandle(ref, () => mockTerminalHandle);
      return actualReact.createElement('div', { 'data-testid': 'mock-terminal' });
    }
  );

  return {
    CodexTerminal: MockTerminal
  };
});

const worktree: WorktreeDescriptor = {
  id: 'worktree-1',
  featureName: 'feature-x',
  branch: 'feature-x',
  path: '/tmp/feature-x',
  createdAt: new Date().toISOString(),
  status: 'ready',
  codexStatus: 'idle'
};

const descriptor: WorktreeTerminalDescriptor = {
  sessionId: 'terminal-1',
  worktreeId: worktree.id,
  shell: '/bin/bash',
  pid: 123,
  startedAt: new Date().toISOString(),
  status: 'running'
};

const createApi = () => {
  const outputListeners: Listener<TerminalOutputPayload>[] = [];
  const exitListeners: Listener<TerminalExitPayload>[] = [];

  const api = {
    startWorktreeTerminal: vi.fn(async () => descriptor),
    sendTerminalInput: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    onTerminalOutput: vi.fn((callback: Listener<TerminalOutputPayload>) => {
      outputListeners.push(callback);
      return () => {
        const index = outputListeners.indexOf(callback);
        if (index >= 0) {
          outputListeners.splice(index, 1);
        }
      };
    }),
    onTerminalExit: vi.fn((callback: Listener<TerminalExitPayload>) => {
      exitListeners.push(callback);
      return () => {
        const index = exitListeners.indexOf(callback);
        if (index >= 0) {
          exitListeners.splice(index, 1);
        }
      };
    })
  } as unknown as RendererApi;

  return {
    api,
    outputListeners,
    exitListeners
  };
};

const resetTerminalMocks = () => {
  mockTerminalHandle.write.mockReset();
  mockTerminalHandle.clear.mockReset();
  mockTerminalHandle.focus.mockReset();
  mockTerminalHandle.setStdinDisabled.mockReset();
  mockTerminalHandle.refreshLayout.mockReset();
  mockTerminalHandle.forceRender.mockReset();
  mockTerminalHandle.getScrollPosition.mockReset();
  mockTerminalHandle.getScrollPosition.mockReturnValue(0);
  mockTerminalHandle.scrollToLine.mockReset();
  mockTerminalHandle.scrollToBottom.mockReset();
  mockOnData = null;
  mockOnResize = null;
};

describe('WorktreeTerminalPane', () => {
  let rafSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetTerminalMocks();
    rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback): number => {
        callback(0);
        return 1;
      });
  });

  afterEach(() => {
    rafSpy.mockRestore();
  });

  it('starts the terminal session when the pane becomes active', async () => {
    const { api } = createApi();
    render(<WorktreeTerminalPane api={api} worktree={worktree} active visible onNotification={() => {}} />);

    await waitFor(() => {
      expect(api.startWorktreeTerminal).toHaveBeenCalledWith(worktree.id);
    });
  });

  it('writes incoming output to the terminal', async () => {
    const { api, outputListeners } = createApi();
    render(<WorktreeTerminalPane api={api} worktree={worktree} active visible onNotification={() => {}} />);

    await waitFor(() => expect(api.startWorktreeTerminal).toHaveBeenCalled());

    const payload: TerminalOutputPayload = {
      sessionId: descriptor.sessionId,
      worktreeId: worktree.id,
      chunk: 'hello world'
    };
    outputListeners.forEach((listener) => listener(payload));

    await waitFor(() => {
      expect(mockTerminalHandle.write).toHaveBeenCalledWith('hello world');
    });
  });

  it('sends user input to the backend when running', async () => {
    const { api } = createApi();
    render(<WorktreeTerminalPane api={api} worktree={worktree} active visible onNotification={() => {}} />);

    await waitFor(() => expect(api.startWorktreeTerminal).toHaveBeenCalled());

    expect(mockOnData).not.toBeNull();
    await act(async () => {
      mockOnData?.('ls\n');
    });

    await waitFor(() => {
      expect(api.sendTerminalInput).toHaveBeenCalledWith(worktree.id, 'ls\n');
    });
  });

  it('propagates resize events to the backend', async () => {
    const { api } = createApi();
    render(<WorktreeTerminalPane api={api} worktree={worktree} active visible onNotification={() => {}} />);

    await waitFor(() => expect(api.startWorktreeTerminal).toHaveBeenCalled());

    expect(mockOnResize).not.toBeNull();
    mockOnResize?.({ cols: 132, rows: 38 });

    await waitFor(() => {
      expect(api.resizeTerminal).toHaveBeenCalledWith({ worktreeId: worktree.id, cols: 132, rows: 38 });
    });
  });

  it('sets stdin to disabled after the terminal exits', async () => {
    const { api, exitListeners } = createApi();
    render(<WorktreeTerminalPane api={api} worktree={worktree} active visible onNotification={() => {}} />);

    await waitFor(() => expect(api.startWorktreeTerminal).toHaveBeenCalled());

    mockTerminalHandle.setStdinDisabled.mockClear();

    const payload: TerminalExitPayload = {
      sessionId: descriptor.sessionId,
      worktreeId: worktree.id,
      exitCode: 0,
      signal: null
    };
    exitListeners.forEach((listener) => listener(payload));

    await waitFor(() => {
      expect(mockTerminalHandle.setStdinDisabled).toHaveBeenLastCalledWith(true);
    });
  });
  it('preserves buffered output and running session when toggling visibility', async () => {
    const { api, outputListeners } = createApi();
    const { rerender } = render(
      <WorktreeTerminalPane api={api} worktree={worktree} active visible onNotification={() => {}} />
    );

    await waitFor(() => expect(api.startWorktreeTerminal).toHaveBeenCalledTimes(1));

    mockTerminalHandle.write.mockClear();
    mockTerminalHandle.getScrollPosition.mockReturnValue(42);

    rerender(
      <WorktreeTerminalPane
        api={api}
        worktree={worktree}
        active={false}
        visible={false}
        onNotification={() => {}}
      />
    );

    const payload: TerminalOutputPayload = {
      sessionId: descriptor.sessionId,
      worktreeId: worktree.id,
      chunk: 'buffered output\n'
    };
    outputListeners.forEach((listener) => listener(payload));

    expect(mockTerminalHandle.write).not.toHaveBeenCalled();

    rerender(
      <WorktreeTerminalPane
        api={api}
        worktree={worktree}
        active
        visible
        shouldAutoStart={false}
        onNotification={() => {}}
      />
    );

    await waitFor(() => {
      expect(api.startWorktreeTerminal).toHaveBeenCalledTimes(1);
      expect(mockTerminalHandle.refreshLayout).toHaveBeenCalled();
      expect(mockTerminalHandle.scrollToLine).toHaveBeenCalledWith(42);
      expect(mockTerminalHandle.write).toHaveBeenCalledWith('buffered output\n');
    });
  });

});
