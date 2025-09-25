import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';

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
