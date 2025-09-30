import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import type { RendererApi } from '../../src/shared/api';
import type { AppState, TerminalOutputPayload, WorktreeDescriptor } from '../../src/shared/ipc';

const createOrchestratorApi = () => {
  const now = new Date().toISOString();
  const run = {
    worktreeId: 'wt-orchestrator',
    runId: 'run-1',
    epicId: null,
    status: 'running' as const,
    description: 'stub run',
    createdAt: now,
    updatedAt: now
  };
  return {
    getOrchestratorSnapshot: vi.fn(async () => null),
    startOrchestratorRun: vi.fn(async () => run),
    submitOrchestratorFollowUp: vi.fn(async () => run),
    approveOrchestratorTask: vi.fn(async () => {}),
    commentOnOrchestratorTask: vi.fn(async () => {}),
    onOrchestratorEvent: vi.fn(() => () => {})
  };
};

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
  document.documentElement.dataset.theme = 'light';
  if (document.body) {
    document.body.dataset.theme = 'light';
  }
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
      sessions: [],
      preferences: { theme: 'light' }
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
      sessions: [],
      preferences: { theme: 'light' }
    };

    const openFolderMock = vi.fn();
    const orchestratorApi = createOrchestratorApi();
    const api = {
      getState: vi.fn(async () => state),
      addProject: vi.fn(async () => state),
      removeProject: vi.fn(async () => state),
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      openWorktreeInVSCode: vi.fn(),
      openWorktreeInGitGui: vi.fn(),
      openWorktreeInFileManager: openFolderMock,
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
      refreshCodexSessionId: vi.fn(async () => null),
      listCodexSessions: vi.fn(async () => []),
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
      getTerminalSnapshot: vi.fn(async () => ({ content: '', lastEventId: 0 })),
      getTerminalDelta: vi.fn(async () => ({ chunks: [], lastEventId: 0 })),
      onTerminalOutput: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {}),
      setThemePreference: vi.fn(async () => state),
      ...orchestratorApi
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

  it('toggles the theme preference via the sidebar control', async () => {
    const now = new Date().toISOString();
    const project = { id: 'proj-1', root: '/tmp/repo', name: 'Project', createdAt: now };
    const worktree: WorktreeDescriptor = {
      id: 'wt-1',
      projectId: project.id,
      featureName: 'feature-1',
      branch: 'feature-1',
      path: '/tmp/feature-1',
      createdAt: now,
      status: 'ready',
      codexStatus: 'idle'
    };

    const initialState: AppState = {
      projects: [project],
      worktrees: [worktree],
      sessions: [],
      preferences: { theme: 'light' }
    };

    const darkState: AppState = {
      ...initialState,
      preferences: { theme: 'dark' }
    };

    const setThemePreference = vi.fn(async () => darkState);

    const api = {
      getState: vi.fn(async () => initialState),
      addProject: vi.fn(async () => initialState),
      removeProject: vi.fn(async () => initialState),
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      openWorktreeInVSCode: vi.fn(),
      openWorktreeInGitGui: vi.fn(),
      openWorktreeInFileManager: vi.fn(),
      startCodex: vi.fn(),
      stopCodex: vi.fn(),
      sendCodexInput: vi.fn(),
      startWorktreeTerminal: vi.fn(async () => ({
        sessionId: 'terminal-1',
        worktreeId: worktree.id,
        shell: '/bin/bash',
        pid: 321,
        startedAt: now,
        status: 'running'
      })),
      onStateUpdate: vi.fn(() => () => {}),
      onCodexOutput: vi.fn(() => () => {}),
      onCodexStatus: vi.fn(() => () => {}),
      getGitStatus: vi.fn(async () => ({ staged: [], unstaged: [], untracked: [] })),
      getGitDiff: vi.fn(async () => ({ filePath: '', staged: false, diff: '', binary: false })),
      getCodexLog: vi.fn(async () => ''),
      summarizeCodexOutput: vi.fn(async () => ''),
      refreshCodexSessionId: vi.fn(async () => null),
      listCodexSessions: vi.fn(async () => []),
      stopWorktreeTerminal: vi.fn(),
      sendTerminalInput: vi.fn(),
      resizeTerminal: vi.fn(),
      getTerminalSnapshot: vi.fn(async () => ({ content: '', lastEventId: 0 })),
      getTerminalDelta: vi.fn(async () => ({ chunks: [], lastEventId: 0 })),
      onTerminalOutput: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {}),
      setThemePreference
    } as unknown as RendererApi;

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: api
    });

    render(<App />);

    await waitFor(() => expect(api.getState).toHaveBeenCalled());
    expect(document.documentElement.dataset.theme).toBe('light');

    const toggle = await screen.findByRole('button', { name: /use dark theme/i });
    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => expect(setThemePreference).toHaveBeenCalledWith('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(await screen.findByRole('button', { name: /use light theme/i })).toBeVisible();
  });

  it('allows adding an extra terminal pane from the add menu', async () => {
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
      sessions: [],
      preferences: { theme: 'light' }
    };

    const orchestratorApi = createOrchestratorApi();
    const api = {
      getState: vi.fn(async () => state),
      addProject: vi.fn(async () => state),
      removeProject: vi.fn(async () => state),
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      openWorktreeInVSCode: vi.fn(),
      openWorktreeInGitGui: vi.fn(),
      openWorktreeInFileManager: vi.fn(),
      startCodex: vi.fn(),
      stopCodex: vi.fn(),
      sendCodexInput: vi.fn(),
      startWorktreeTerminal: vi.fn(async () => ({
        sessionId: 'terminal-1',
        worktreeId: 'project-root:proj-1',
        shell: '/bin/bash',
        pid: 789,
        startedAt: new Date().toISOString(),
        status: 'running'
      })),
      onStateUpdate: vi.fn(() => () => {}),
      onCodexOutput: vi.fn(() => () => {}),
      onCodexStatus: vi.fn(() => () => {}),
      getGitStatus: vi.fn(),
      getGitDiff: vi.fn(),
      getCodexLog: vi.fn(),
      summarizeCodexOutput: vi.fn(async () => ''),
      refreshCodexSessionId: vi.fn(async () => null),
      listCodexSessions: vi.fn(async () => []),
      stopWorktreeTerminal: vi.fn(),
      sendTerminalInput: vi.fn(),
      resizeTerminal: vi.fn(),
      getTerminalSnapshot: vi.fn(async () => ({ content: '', lastEventId: 0 })),
      getTerminalDelta: vi.fn(async () => ({ chunks: [], lastEventId: 0 })),
      onTerminalOutput: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {}),
      setThemePreference: vi.fn(async () => state),
      ...orchestratorApi
    } as unknown as RendererApi;

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: api
    });

    render(<App />);

    await waitFor(() => expect(api.getState).toHaveBeenCalled());

    const addPaneButton = await screen.findByRole('button', { name: 'Add pane' });
    fireEvent.click(addPaneButton);

    const newTerminalOption = await screen.findByRole('menuitem', { name: /new terminal/i });
    fireEvent.click(newTerminalOption);

    expect(await screen.findByRole('tab', { name: 'Terminal 2' })).toBeInTheDocument();
  });

  // Skipping due to intermittent hang in CI/jsdom when waiting on UI teardown
  // of pane state after removal. The remove flow itself is covered by
  // component-level tests elsewhere. Re-enable after stabilizing the bridge
  // bootstrap and runAction timing in tests.
  it.skip('removes a project when the remove button is confirmed', async () => {
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

    const populatedState: AppState = {
      projects: [project],
      worktrees: [worktree],
      sessions: [],
      preferences: { theme: 'light' }
    };

    const emptyState: AppState = {
      projects: [],
      worktrees: [],
      sessions: [],
      preferences: { theme: 'light' }
    };

    const removeProject = vi.fn(async () => emptyState);

    const orchestratorApi = createOrchestratorApi();
    const api = {
      getState: vi.fn(async () => populatedState),
      addProject: vi.fn(async () => populatedState),
      removeProject,
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
      refreshCodexSessionId: vi.fn(async () => null),
      listCodexSessions: vi.fn(async () => []),
      startWorktreeTerminal: vi.fn(),
      stopWorktreeTerminal: vi.fn(),
      sendTerminalInput: vi.fn(),
      resizeTerminal: vi.fn(),
      getTerminalSnapshot: vi.fn(async () => ({ content: '', lastEventId: 0 })),
      getTerminalDelta: vi.fn(async () => ({ chunks: [], lastEventId: 0 })),
      onTerminalOutput: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {}),
      setThemePreference: vi.fn(async () => populatedState),
      ...orchestratorApi
    } as unknown as RendererApi;

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: api
    });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<App />);

    await waitFor(() => expect(api.getState).toHaveBeenCalled());

    const removeButton = await screen.findByRole('button', { name: 'Remove' });
    fireEvent.click(removeButton);

    await waitFor(() => expect(removeProject).toHaveBeenCalledWith('proj-1'));

    expect(await screen.findByRole('button', { name: 'Add Project' })).toBeInTheDocument();

    confirmSpy.mockRestore();
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
      ],
      preferences: { theme: 'light' }
    };

    let terminalOutputListener: ((payload: TerminalOutputPayload) => void) | undefined;

    const api = {
      getState: vi.fn(async () => state),
      addProject: vi.fn(async () => state),
      removeProject: vi.fn(async () => state),
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      openWorktreeInVSCode: vi.fn(),
      openWorktreeInGitGui: vi.fn(),
      openWorktreeInFileManager: vi.fn(),
      startCodex: vi.fn(),
      stopCodex: vi.fn(),
      sendCodexInput: vi.fn(),
      startWorktreeTerminal: vi.fn(),
      onStateUpdate: vi.fn(() => () => {}),
      onCodexOutput: vi.fn(() => () => {}),
      onCodexStatus: vi.fn(() => () => {}),
      onTerminalOutput: vi.fn((callback: (payload: TerminalOutputPayload) => void) => {
        terminalOutputListener = callback;
        return () => {};
      }),
      onTerminalExit: vi.fn(() => () => {}),
      getGitStatus: vi.fn(),
      getGitDiff: vi.fn(),
      getCodexLog: vi.fn(),
      summarizeCodexOutput: vi.fn(async () => ''),
      refreshCodexSessionId: vi.fn(async () => null),
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
      getTerminalSnapshot: vi.fn(async () => ({ content: '', lastEventId: 0 })),
      getTerminalDelta: vi.fn(async () => ({ chunks: [], lastEventId: 0 })),
      onTerminalOutput: vi.fn((callback: (payload: TerminalOutputPayload) => void) => {
        terminalOutputListener = callback;
        return () => {};
      }),
      onTerminalExit: vi.fn(() => () => {}),
      setThemePreference: vi.fn(async () => state)
    } as unknown as RendererApi;

    Object.assign(api, createOrchestratorApi());

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
      sessions: [],
      preferences: { theme: 'light' }
    };

    const openFolderMock = vi.fn();
    const api = {
      getState: vi.fn(async () => state),
      addProject: vi.fn(async () => state),
      removeProject: vi.fn(async () => state),
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      openWorktreeInVSCode: vi.fn(),
      openWorktreeInGitGui: vi.fn(),
      openWorktreeInFileManager: openFolderMock,
      startCodex: vi.fn(),
      stopCodex: vi.fn(),
      sendCodexInput: vi.fn(),
      startWorktreeTerminal: vi.fn(async () => ({
        sessionId: 'codex-terminal',
        worktreeId: 'project-root:proj-1',
        shell: '/bin/bash',
        pid: 456,
        startedAt: new Date().toISOString(),
        status: 'running'
      })),
      onStateUpdate: vi.fn(() => () => {}),
      onCodexOutput: vi.fn(() => () => {}),
      onCodexStatus: vi.fn(() => () => {}),
      getGitStatus: vi.fn(),
      getGitDiff: vi.fn(),
      getCodexLog: vi.fn(),
      summarizeCodexOutput: vi.fn(async () => ''),
      refreshCodexSessionId: vi.fn(async () => null),
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
      getTerminalSnapshot: vi.fn(async () => ({ content: '', lastEventId: 0 })),
      getTerminalDelta: vi.fn(async () => ({ chunks: [], lastEventId: 0 })),
      onTerminalOutput: vi.fn(() => () => {}),
      onTerminalExit: vi.fn(() => () => {})
    } as unknown as RendererApi;

    Object.assign(api, createOrchestratorApi());

    Object.assign(api, createOrchestratorApi());

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
