import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parse as parseDiff, html as createDiffHtml } from 'diff2html';
import hljs from 'highlight.js/lib/common';
import 'diff2html/bundles/css/diff2html.min.css';

import type {
  GitStatusSummary,
  GitFileChange,
  GitDiffResponse,
  WorktreeDescriptor
} from '@shared/ipc';
import type { RendererApi } from '@shared/api';

interface GitPanelProps {
  api: RendererApi;
  worktree: WorktreeDescriptor;
}

type Selection = {
  path: string;
  staged: boolean;
};

type WorktreeSnapshot = {
  selection: Selection | null;
  sidebarScroll: number;
  diffScroll: number;
};

const SECTION_LABELS = {
  staged: 'Staged Changes',
  unstaged: 'Unstaged Changes',
  untracked: 'Untracked'
} as const;

type SectionKey = keyof GitStatusSummary;

const SIDEBAR_MIN = 0.2;
const SIDEBAR_MAX = 0.75;

export const GitPanel: React.FC<GitPanelProps> = ({ api, worktree }) => {
  const [status, setStatus] = useState<GitStatusSummary | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarRatio, setSidebarRatio] = useState(0.35);
  const sidebarStorageKey = useMemo(() => `layout/${worktree.id}/git-sidebar-ratio`, [worktree.id]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const snapshotsRef = useRef<Record<string, WorktreeSnapshot>>({});
  const previousWorktreeIdRef = useRef<string | null>(null);
  const restoreScrollRef = useRef<{ sidebar: number; diff: number } | null>(null);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const refreshStatus = useCallback(
    async (preferredSelection?: Selection | null) => {
      setLoading(true);
      setError(null);
      try {
        const summary = await api.getGitStatus(worktree.id);
        setStatus(summary);
        setSelection((current) => {
          const resolveCandidate = (candidate: Selection | null | undefined): Selection | null => {
            if (!candidate) {
              return null;
            }
            const stagedMatch = summary.staged.find((file) => file.path === candidate.path);
            if (stagedMatch) {
              return { path: stagedMatch.path, staged: true };
            }
            const unstagedMatch = summary.unstaged.find((file) => file.path === candidate.path);
            if (unstagedMatch) {
              return { path: unstagedMatch.path, staged: false };
            }
            const untrackedMatch = summary.untracked.find((file) => file.path === candidate.path);
            if (untrackedMatch) {
              return { path: untrackedMatch.path, staged: false };
            }
            return null;
          };

          const preferred = resolveCandidate(preferredSelection);
          if (preferred) {
            return preferred;
          }

          const existing = resolveCandidate(current);
          if (existing) {
            return existing;
          }

          return findFirstPath(summary);
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load status');
      } finally {
        setLoading(false);
      }
    },
    [api, worktree.id]
  );

  useEffect(() => {
    const previousId = previousWorktreeIdRef.current;
    if (previousId && previousId !== worktree.id) {
      snapshotsRef.current[previousId] = {
        selection: selectionRef.current,
        sidebarScroll: sidebarRef.current?.scrollTop ?? 0,
        diffScroll: containerRef.current?.scrollTop ?? 0
      };
    }

    previousWorktreeIdRef.current = worktree.id;

    const snapshot = snapshotsRef.current[worktree.id];
    restoreScrollRef.current = snapshot ? { sidebar: snapshot.sidebarScroll, diff: snapshot.diffScroll } : null;

    setStatus(null);
    setDiff(null);
    setError(null);
    setSelection(null);
    void refreshStatus(snapshot?.selection ?? null);
  }, [worktree.id, refreshStatus]);

  useEffect(() => {
    if (!selection) {
      setDiff(null);
      return;
    }

    setDiffLoading(true);
    setError(null);
    api
      .getGitDiff({
        worktreeId: worktree.id,
        filePath: selection.path,
        staged: selection.staged
      })
      .then((response) => {
        setDiff(response);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load diff');
      })
      .finally(() => {
        setDiffLoading(false);
      });
  }, [selection, api, worktree.id]);

  useEffect(() => {
    if (!diff) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    container.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
  }, [diff]);

  const diffHtml = useMemo(() => {
    if (!diff || diff.diff.trim().length === 0) {
      return '';
    }
    const diffJson = parseDiff(diff.diff.trim(), { inputFormat: 'diff', outputFormat: 'line-by-line' });
    return createDiffHtml(diffJson, {
      drawFileList: false,
      matching: 'lines',
      outputFormat: 'line-by-line'
    });
  }, [diff]);

  const handleRatioChange = useCallback((nextRatio: number) => {
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, nextRatio));
    setSidebarRatio(clamped);
    try {
      window.localStorage.setItem(sidebarStorageKey, clamped.toString());
    } catch (error) {
      console.warn('[git] failed to persist sidebar ratio', error);
    }
  }, [sidebarStorageKey]);

  useEffect(() => {
    const defaultRatio = 0.35;
    try {
      const stored = window.localStorage.getItem(sidebarStorageKey);
      if (stored) {
        const parsed = Number.parseFloat(stored);
        if (!Number.isNaN(parsed)) {
          const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, parsed));
          setSidebarRatio(clamped);
          return;
        }
      }
    } catch (error) {
      console.warn('[git] failed to load sidebar ratio', error);
    }
    setSidebarRatio(defaultRatio);
  }, [sidebarStorageKey]);

  const handleRefreshClick = useCallback(() => {
    void refreshStatus(selectionRef.current);
  }, [refreshStatus]);

  useLayoutEffect(() => {
    const pending = restoreScrollRef.current;
    if (!pending) {
      return;
    }
    if (sidebarRef.current) {
      sidebarRef.current.scrollTop = pending.sidebar;
    }
    if (containerRef.current) {
      containerRef.current.scrollTop = pending.diff;
    }
    restoreScrollRef.current = null;
  }, [worktree.id, diffHtml]);

  return (
    <div className="git-panel">
      <header className="git-panel__header">
        <h2>Git Changes</h2>
        <div className="git-panel__actions">
          <button type="button" onClick={handleRefreshClick} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>
      {error ? <div className="git-panel__error">{error}</div> : null}
      <div className="git-panel__body" style={{ gridTemplateColumns: `${sidebarRatio * 100}% 6px 1fr` }}>
        <aside className="git-panel__sidebar" ref={sidebarRef}>
          {(['staged', 'unstaged', 'untracked'] as SectionKey[]).map((section) => (
            <GitSection
              key={section}
              title={SECTION_LABELS[section]}
              files={status?.[section] ?? []}
              selection={selection}
              onSelect={setSelection}
              staged={section === 'staged'}
              loading={loading}
            />
          ))}
          {status &&
          status.staged.length === 0 &&
          status.unstaged.length === 0 &&
          status.untracked.length === 0 ? (
            <p className="git-panel__empty">Working tree clean.</p>
          ) : null}
        </aside>
        <div
          className="git-panel__divider"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={(event) => {
            const divider = event.currentTarget as HTMLElement;
            const startX = event.clientX;
            const container = divider.parentElement;
            const initialRatio = sidebarRatio;
            if (!container) {
              return;
            }
            const rect = container.getBoundingClientRect();
            divider.setPointerCapture(event.pointerId);
            const handlePointerMove = (moveEvent: PointerEvent) => {
              const delta = moveEvent.clientX - startX;
              const nextRatio = initialRatio + delta / rect.width;
              handleRatioChange(nextRatio);
              moveEvent.preventDefault();
            };
            const handlePointerUp = () => {
              divider.releasePointerCapture(event.pointerId);
              divider.removeEventListener('pointermove', handlePointerMove);
            };
            divider.addEventListener('pointermove', handlePointerMove);
            divider.addEventListener('pointerup', handlePointerUp, { once: true });
            event.preventDefault();
          }}
        />
        <section className="git-panel__diff" ref={containerRef}>
          {diffLoading ? <p className="git-panel__loading">Loading diff…</p> : null}
          {!diffLoading && diffHtml ? (
            <div
              className="git-panel__diff-content diff2html"
              dangerouslySetInnerHTML={{ __html: diffHtml }}
            />
          ) : null}
          {!diffLoading && (!diffHtml || diffHtml.trim().length === 0) ? (
            <div className="git-panel__no-diff">
              <p>Select a file to view its diff.</p>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};

interface GitSectionProps {
  title: string;
  files: GitFileChange[];
  staged: boolean;
  selection: Selection | null;
  onSelect(selection: Selection): void;
  loading: boolean;
}

const GitSection: React.FC<GitSectionProps> = ({
  title,
  files,
  staged,
  selection,
  onSelect,
  loading
}) => {
  if (!files.length) {
    return null;
  }

  return (
    <div className="git-section">
      <h3>{title}</h3>
      <ul>
        {files.map((file) => {
          const isActive = selection?.path === file.path && selection?.staged === staged;
          return (
            <li key={`${file.path}-${staged ? 'staged' : 'unstaged'}`}>
              <button
                type="button"
                className={`git-file ${isActive ? 'active' : ''}`}
                onClick={() => onSelect({ path: file.path, staged })}
                disabled={loading}
              >
                <span className="git-file__status">{staged ? file.index : file.workingTree || '?'}</span>
                <span className="git-file__path">{file.displayPath}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const findFirstPath = (summary: GitStatusSummary): Selection | null => {
  if (summary.staged.length > 0) {
    return { path: summary.staged[0].path, staged: true };
  }
  if (summary.unstaged.length > 0) {
    return { path: summary.unstaged[0].path, staged: false };
  }
  if (summary.untracked.length > 0) {
    return { path: summary.untracked[0].path, staged: false };
  }
  return null;
};
