import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import type { RendererApi } from '../../src/shared/api';
import type { AppState, TerminalOutputPayload, WorktreeDescriptor } from '../../src/shared/ipc';

vi.mock('../../src/renderer/components/CodexPane', () => ({
  CodexPane: () => <div data-testid="mock-codex-pane" />
}));

vi.mock('../../src/renderer/components/CodexTerminalShellPane', () => ({
  CodexTerminalShellPane: () => <div data-testid="mock-codex-terminal-pane" />
}));

vi.mock('../../src/renderer/components/WorktreeTerminalPane', () => ({
  WorktreeTerminalPane: () => <div data-testid="mock-terminal-pane" />
}));

vi.mock('../../src/renderer/components/GitPanel', () => ({
  GitPanel: () => <div data-testid="mock-git-panel" />
}));

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).api;
  vi.useRealTimers();
});

describe('App', () => {
  it('renders the project selection call-to-action by default', async () => {
    render(<App />);
    const button = await screen.findByRole('button', { name: /add project/i });
    expect(button).toBeVisible();
  });

  it('groups worktrees by project when state is populated', async () => {
    const now = new Date().toISOString();
    const populatedState = {
      projects: [
        { id: 'proj-a', root: '/tmp/proj-a', name: 'Project A', createdAt: now },
        { id: 'proj-b', root: '/tmp/proj-b', name: 'Project B', createdAt: now }
      ],
      worktrees: [
        {
          id: 'wt-a',
          projectId: 'proj-a',
          featureName: 'alpha',
          branch: 'alpha',
          path: '/tmp/proj-a-alpha',
          createdAt: now,
          status: 'ready',
          codexStatus: 'idle'
        },
        {
          id: 'wt-b',
          projectId: 'proj-b',
          featureName: 'beta',
          branch: 'beta',
          path: '/tmp/proj-b-beta',
          createdAt: now,
          status: 'ready',
          codexStatus: 'idle'
        }
      ],
      sessions: []
    };

    (window.api.getState as vi.Mock).mockResolvedValue(populatedState);

    render(<App />);

    expect(await screen.findAllByRole('tab', { name: /alpha/i })).toHaveLength(2);
    expect(screen.getAllByRole('tab', { name: /beta/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /\+ worktree/i })).toHaveLength(2);
  });
});

describe('App with project state', () => {
  it('renders codex and terminal tabs for the active worktree', async () => {
    const worktree: WorktreeDescriptor = {
      id: 'wt-1',
      projectId: 'proj-1',
      featureName: 'feature-1',
      branch: 'feature-1',
      path: '/tmp/feature-1',
      createdAt: new Date().toISOString(),
      status: 'ready',
      codexStatus: 'idle'
    };

    const now = new Date().toISOString();
    const project = { id: 'proj-1', root: '/tmp/repo', name: 'Project', createdAt: now };
    const state: AppState = {
      projects: [project],
      worktrees: [
        {
          ...worktree,
          projectId: project.id
        }
      ],
      sessions: []
    };

    const openFolderMock = vi.fn();
    const api = {
      getState: vi.fn(async () => state),
      addProject: vi.fn(async () => state),
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      openWorktreeInVSCode: vi.fn(),
      openWorktreeInGitGui: vi.fn(),
      openWorktreeInFileManager: openFolderMock,
      startCodex: vi.fn(),
      stopCodex: vi.fn(),
      sendCodexInput: vi.fn(),
      startCodexTerminal: vi.fn(),
      stopCodexTerminal: vi.fn(),
      sendCodexTerminalInput: vi.fn(),
      resizeCodexTerminal: vi.fn(),
      onStateUpdate: vi.fn(() => () => {}),
      onCodexOutput: vi.fn(() => () => {}),
      onCodexStatus: vi.fn(() => () => {}),
      onCodexTerminalOutput: vi.fn(() => () => {}),
      onCodexTerminalExit: vi.fn(() => () => {}),
      getGitStatus: vi.fn(),
      getGitDiff: vi.fn(),
      getCodexLog: vi.fn(),
      summarizeCodexOutput: vi.fn(async () => ''),
      startWorktreeTerminal: vi.fn(async () => ({
        sessionId: 'terminal-1',
        worktreeId: worktree.id,
        shell: '/bin/bash',
        pid: 123,
        startedAt: new Date().toISOString(),
        status: 'running'
      })),
      stopWorktreeTerminal: vi.fn(),
      sendTerminalInput: vi.fn(),
      resizeTerminal: vi.fn(),
      onTerminalOutput: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {})
    } as unknown as RendererApi;

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: api
    });

    render(<App />);

    await waitFor(() => expect(api.getState).toHaveBeenCalled());

    expect(screen.getByRole('tab', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Project / feature-1' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Folder' }));
    });
    expect(openFolderMock).toHaveBeenCalledWith(worktree.id);
  });

  it('displays the latest codex status line beneath the header', async () => {
    const worktree: WorktreeDescriptor = {
      id: 'wt-1',
      projectId: 'proj-1',
      featureName: 'feature-1',
      branch: 'feature-1',
      path: '/tmp/feature-1',
      createdAt: new Date().toISOString(),
      status: 'ready',
      codexStatus: 'running'
    };

    const project = { id: 'proj-1', root: '/tmp/repo', name: 'Project', createdAt: new Date().toISOString() };

    const state: AppState = {
      projects: [project],
      worktrees: [worktree],
      sessions: [
        {
          id: 'session-1',
          worktreeId: worktree.id,
          status: 'running',
          startedAt: new Date().toISOString()
        }
      ]
    };

    let terminalOutputListener: ((payload: TerminalOutputPayload) => void) | undefined;

    const api = {
      getState: vi.fn(async () => state),
      addProject: vi.fn(async () => state),
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      openWorktreeInVSCode: vi.fn(),
      openWorktreeInGitGui: vi.fn(),
      openWorktreeInFileManager: vi.fn(),
      startCodex: vi.fn(),
      stopCodex: vi.fn(),
      sendCodexInput: vi.fn(),
      startCodexTerminal: vi.fn(),
      stopCodexTerminal: vi.fn(),
      sendCodexTerminalInput: vi.fn(),
      resizeCodexTerminal: vi.fn(),
      onStateUpdate: vi.fn(() => () => {}),
      onCodexOutput: vi.fn(() => () => {}),
      onCodexStatus: vi.fn(() => () => {}),
      onCodexTerminalOutput: vi.fn((callback: (payload: TerminalOutputPayload) => void) => {
        terminalOutputListener = callback;
        return () => {};
      }),
      onCodexTerminalExit: vi.fn(() => () => {}),
      getGitStatus: vi.fn(),
      getGitDiff: vi.fn(),
      getCodexLog: vi.fn(),
      summarizeCodexOutput: vi.fn(async () => ''),
      startWorktreeTerminal: vi.fn(async () => ({
        sessionId: 'terminal-1',
        worktreeId: worktree.id,
        shell: '/bin/bash',
        pid: 123,
        startedAt: new Date().toISOString(),
        status: 'running'
      })),
      stopWorktreeTerminal: vi.fn(),
      sendTerminalInput: vi.fn(),
      resizeTerminal: vi.fn(),
      onTerminalOutput: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {})
    } as unknown as RendererApi;

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: api
    });

    render(<App />);

    await waitFor(() => expect(api.getState).toHaveBeenCalled());
    expect(terminalOutputListener).toBeDefined();

    await act(async () => {
      terminalOutputListener?.({
        sessionId: 'terminal-1',
        worktreeId: worktree.id,
        chunk: 'Reviewing and refining documentation and imports (6m 30s • Esc to interrupt)\n'
      });
    });

    expect(
      await screen.findByText('Reviewing and refining documentation and imports', { exact: false })
    ).toBeInTheDocument();

    await act(async () => {
      terminalOutputListener?.({
        sessionId: 'terminal-1',
        worktreeId: worktree.id,
        chunk:
          "36 use alloy_signer::SignerSync;Identifying redundant import in tests(15m 10s • Esc to interrupt)▌Explain this codebase ⏎ send Ctrl+J newline Ctrl+T transcript Ctrl+C quit 208K tokens used 74% context left\n"
      });
    });

    expect(
      await screen.findByText('Identifying redundant import in tests', { exact: false })
    ).toBeInTheDocument();

    await act(async () => {
      terminalOutputListener?.({
        sessionId: 'terminal-1',
        worktreeId: worktree.id,
        chunk:
          'make: *** [Makefile:440: clippy] Error 101Reviewing and refining documentation and imports(6m 30s • Esc to interrupt)\n'
      });
    });

    expect(
      await screen.findByText('Error 101 Reviewing and refining documentation and imports', { exact: false })
    ).toBeInTheDocument();
  });

  it('renders the main project tab without showing the worktree prompt', async () => {
    const worktree: WorktreeDescriptor = {
      id: 'wt-1',
      projectId: 'proj-1',
      featureName: 'feature-1',
      branch: 'feature-1',
      path: '/tmp/feature-1',
      createdAt: new Date().toISOString(),
      status: 'ready',
      codexStatus: 'idle'
    };

    const project = { id: 'proj-1', root: '/tmp/repo', name: 'Project', createdAt: new Date().toISOString() };

    const state: AppState = {
      projects: [project],
      worktrees: [worktree],
      sessions: []
    };

    const openFolderMock = vi.fn();
    const api = {
      getState: vi.fn(async () => state),
      addProject: vi.fn(async () => state),
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      openWorktreeInVSCode: vi.fn(),
      openWorktreeInGitGui: vi.fn(),
      openWorktreeInFileManager: openFolderMock,
      startCodex: vi.fn(),
      stopCodex: vi.fn(),
      sendCodexInput: vi.fn(),
      startCodexTerminal: vi.fn(async () => ({
        sessionId: 'codex-terminal',
        worktreeId: 'project-root:proj-1',
        shell: '/bin/bash',
        pid: 456,
        startedAt: new Date().toISOString(),
        status: 'running'
      })),
      stopCodexTerminal: vi.fn(),
      sendCodexTerminalInput: vi.fn(),
      resizeCodexTerminal: vi.fn(),
      onStateUpdate: vi.fn(() => () => {}),
      onCodexOutput: vi.fn(() => () => {}),
      onCodexStatus: vi.fn(() => () => {}),
      onCodexTerminalOutput: vi.fn(() => () => {}),
      onCodexTerminalExit: vi.fn(() => () => {}),
      getGitStatus: vi.fn(),
      getGitDiff: vi.fn(),
      getCodexLog: vi.fn(),
      summarizeCodexOutput: vi.fn(async () => ''),
      startWorktreeTerminal: vi.fn(async () => ({
        sessionId: 'terminal-1',
        worktreeId: 'project-root:proj-1',
        shell: '/bin/bash',
        pid: 789,
        startedAt: new Date().toISOString(),
        status: 'running'
      })),
      stopWorktreeTerminal: vi.fn(),
      sendTerminalInput: vi.fn(),
      resizeTerminal: vi.fn(),
      onTerminalOutput: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {})
    } as unknown as RendererApi;

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: api
    });

    render(<App />);

    await waitFor(() => expect(api.getState).toHaveBeenCalled());

    const mainTab = await screen.findByRole('tab', { name: /main/i });
    await act(async () => {
      fireEvent.click(mainTab);
    });

    expect(screen.queryByText(/Select a worktree/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Project / main' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Folder' }));
    });
    expect(openFolderMock).toHaveBeenCalledWith('project-root:proj-1');
  });

});
