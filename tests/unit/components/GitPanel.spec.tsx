import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GitPanel } from '../../../src/renderer/components/GitPanel';
import type { RendererApi } from '../../../src/shared/api';
import type { GitStatusSummary, WorktreeDescriptor } from '../../../src/shared/ipc';

describe('GitPanel', () => {
  const createWorktree = (id: string, featureName: string): WorktreeDescriptor => ({
    id,
    projectId: 'proj-1',
    featureName,
    branch: featureName,
    path: `/tmp/${featureName}`,
    createdAt: new Date().toISOString(),
    status: 'ready',
    codexStatus: 'idle'
  });

  const createStatus = (paths: { staged?: string[]; unstaged?: string[]; untracked?: string[] }): GitStatusSummary => ({
    staged: (paths.staged ?? []).map((path) => ({
      path,
      displayPath: path,
      index: 'M',
      workingTree: ' '
    })),
    unstaged: (paths.unstaged ?? []).map((path) => ({
      path,
      displayPath: path,
      index: ' ',
      workingTree: 'M'
    })),
    untracked: (paths.untracked ?? []).map((path) => ({
      path,
      displayPath: path,
      index: '?',
      workingTree: '?'
    }))
  });

  const createApi = (statuses: Record<string, GitStatusSummary>): RendererApi => {
    const getGitStatus = vi.fn(async (worktreeId: string) => {
      const summary = statuses[worktreeId];
      if (!summary) {
        throw new Error(`no status for ${worktreeId}`);
      }
      return summary;
    });

    const getGitDiff = vi.fn(async ({ filePath, staged, worktreeId }) => ({
      filePath,
      staged: staged ?? false,
      worktreeId,
      diff: `diff --git a/${filePath} b/${filePath}`,
      binary: false
    }));

    return {
      getState: vi.fn(),
      addProject: vi.fn(),
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      removeProject: vi.fn(),
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
      onStateUpdate: vi.fn(),
      onCodexOutput: vi.fn(),
      onCodexStatus: vi.fn(),
      onCodexTerminalOutput: vi.fn(),
      onCodexTerminalExit: vi.fn(),
      getGitStatus,
      getGitDiff,
      getCodexLog: vi.fn(),
      startWorktreeTerminal: vi.fn(),
      stopWorktreeTerminal: vi.fn(),
      sendTerminalInput: vi.fn(),
      resizeTerminal: vi.fn(),
      getTerminalSnapshot: vi.fn(async () => ({ content: '', lastEventId: 0 })),
      getTerminalDelta: vi.fn(async () => ({ chunks: [], lastEventId: 0 })),
      onTerminalOutput: vi.fn(),
      onTerminalExit: vi.fn()
    } as unknown as RendererApi;
  };

  it('restores selection and scroll position when returning to a worktree', async () => {
    const worktreeA = createWorktree('wt-a', 'feature-a');
    const worktreeB = createWorktree('wt-b', 'feature-b');

    const statuses: Record<string, GitStatusSummary> = {
      'wt-a': createStatus({
        staged: ['src/staged-a.ts'],
        unstaged: ['src/alpha.ts', 'src/beta.ts']
      }),
      'wt-b': createStatus({
        staged: ['src/other.ts'],
        unstaged: ['src/gamma.ts']
      })
    };

    const api = createApi(statuses);
    const { rerender } = render(<GitPanel api={api} worktree={worktreeA} />);

    await waitFor(() => expect(api.getGitStatus).toHaveBeenCalledWith('wt-a'));
    await waitFor(() =>
      expect(api.getGitDiff).toHaveBeenLastCalledWith(
        expect.objectContaining({ worktreeId: 'wt-a', filePath: 'src/staged-a.ts', staged: true })
      )
    );

    const sidebar = document.querySelector('.git-panel__sidebar') as HTMLElement;
    const diff = document.querySelector('.git-panel__diff') as HTMLElement;
    expect(sidebar).toBeTruthy();
    expect(diff).toBeTruthy();

    fireEvent.click(screen.getByText('src/beta.ts'));

    await waitFor(() =>
      expect(api.getGitDiff).toHaveBeenLastCalledWith(
        expect.objectContaining({ worktreeId: 'wt-a', filePath: 'src/beta.ts', staged: false })
      )
    );

    sidebar.scrollTop = 48;
    diff.scrollTop = 96;

    rerender(<GitPanel api={api} worktree={worktreeB} />);

    await waitFor(() => expect(api.getGitStatus).toHaveBeenLastCalledWith('wt-b'));

    const sidebarB = document.querySelector('.git-panel__sidebar') as HTMLElement;
    const diffB = document.querySelector('.git-panel__diff') as HTMLElement;
    sidebarB.scrollTop = 30;
    diffB.scrollTop = 60;

    rerender(<GitPanel api={api} worktree={worktreeA} />);

    await waitFor(() => expect(api.getGitStatus).toHaveBeenLastCalledWith('wt-a'));

    await waitFor(() => {
      const active = document.querySelector('.git-file.active');
      expect(active?.textContent).toContain('src/beta.ts');
    });

    await waitFor(() => {
      const restoredSidebar = document.querySelector('.git-panel__sidebar') as HTMLElement;
      const restoredDiff = document.querySelector('.git-panel__diff') as HTMLElement;
      expect(restoredSidebar.scrollTop).toBe(48);
      expect(restoredDiff.scrollTop).toBe(96);
    });

    await waitFor(() =>
      expect(api.getGitDiff).toHaveBeenLastCalledWith(
        expect.objectContaining({ worktreeId: 'wt-a', filePath: 'src/beta.ts', staged: false })
      )
    );
  });
});
