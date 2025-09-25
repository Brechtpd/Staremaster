import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import type { RendererApi } from '../../src/shared/api';
import type { AppState, WorktreeDescriptor } from '../../src/shared/ipc';

vi.mock('../../src/renderer/components/CodexPane', () => ({
  CodexPane: () => <div data-testid="mock-codex-pane" />
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

    expect(await screen.findByRole('button', { name: /project a/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /project b/i })).toBeVisible();
    expect(await screen.findByRole('button', { name: /alpha/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /beta/i })).toBeVisible();
    expect(screen.getAllByRole('button', { name: /\+ new worktree/i })).toHaveLength(2);
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

    const api = {
      getState: vi.fn(async () => state),
      addProject: vi.fn(async () => state),
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      openWorktreeInVSCode: vi.fn(),
      openWorktreeInGitGui: vi.fn(),
      startCodex: vi.fn(),
      stopCodex: vi.fn(),
      sendCodexInput: vi.fn(),
      onStateUpdate: vi.fn(() => () => {}),
      onCodexOutput: vi.fn(() => () => {}),
      onCodexStatus: vi.fn(() => () => {}),
      getGitStatus: vi.fn(),
      getGitDiff: vi.fn(),
      getCodexLog: vi.fn(),
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
  });
});
