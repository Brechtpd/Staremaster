import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppState, WorktreeDescriptor } from '@shared/ipc';
import type { RendererApi } from '@shared/api';
import { GitPanel } from './components/GitPanel';
import { ResizableColumns } from './components/ResizableColumns';
import { CodexPane } from './components/CodexPane';
import { WorktreeTerminalPane } from './components/WorktreeTerminalPane';
import {
  buildCodexSessions,
  getLatestSessionsByWorktree,
  DerivedCodexSession
} from './codex-model';

const EMPTY_STATE: AppState = {
  projectRoot: null,
  worktrees: [],
  sessions: []
};

const SIDEBAR_MIN_RATIO = 0.1;
const SIDEBAR_MAX_RATIO = 0.28;
const DEFAULT_TAB = 'codex' as const;

type WorktreeTabId = 'codex' | 'terminal';

export const App: React.FC = () => {
  const [bridge, setBridge] = useState<RendererApi | null>(() => window.api ?? null);
  const api = useMemo(() => bridge ?? createRendererStub(), [bridge]);
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const [isCreateModalOpen, setCreateModalOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [sidebarRatio, setSidebarRatio] = useState(0.25);
  const projectKey = useMemo(
    () => (state.projectRoot ? encodeURIComponent(state.projectRoot) : 'global'),
    [state.projectRoot]
  );
  const sidebarStorageKey = useMemo(() => `layout/${projectKey}/sidebar-ratio`, [projectKey]);
  const codexColumnsStorageKey = useMemo(() => `layout/${projectKey}/codex-columns`, [projectKey]);
  const worktreeTabStorageKey = useMemo(() => `layout/${projectKey}/worktree-tab`, [projectKey]);
  const [activeTab, setActiveTab] = useState<WorktreeTabId>(DEFAULT_TAB);

  useEffect(() => {
    const defaultRatio = Math.min(SIDEBAR_MAX_RATIO, Math.max(SIDEBAR_MIN_RATIO, 0.25));
    try {
      const stored = window.localStorage.getItem(sidebarStorageKey);
      if (stored) {
        const parsed = Number.parseFloat(stored);
        if (!Number.isNaN(parsed)) {
          const clamped = Math.min(SIDEBAR_MAX_RATIO, Math.max(SIDEBAR_MIN_RATIO, parsed));
          setSidebarRatio(clamped);
          return;
        }
      }
    } catch (error) {
      console.warn('[layout] failed to load sidebar ratio', error);
    }
    setSidebarRatio(defaultRatio);
  }, [sidebarStorageKey]);

  const setPersistedSidebarRatio = useCallback((value: number) => {
    const clamped = Math.min(SIDEBAR_MAX_RATIO, Math.max(SIDEBAR_MIN_RATIO, value));
    setSidebarRatio(clamped);
    try {
      window.localStorage.setItem(sidebarStorageKey, clamped.toString());
    } catch (error) {
      console.warn('[layout] failed to persist sidebar ratio', error);
    }
  }, [sidebarStorageKey]);

  const changeWorktree = useCallback((nextId: string | null) => {
    setSelectedWorktreeId((current) => {
      if (current && current === nextId) {
        return current;
      }
      return nextId;
    });
  }, []);

  const selectedWorktree = useMemo<WorktreeDescriptor | null>(() => {
    if (!selectedWorktreeId) {
      return null;
    }
    return state.worktrees.find((worktree) => worktree.id === selectedWorktreeId) ?? null;
  }, [selectedWorktreeId, state.worktrees]);

  const latestSessionsByWorktree = useMemo(
    () => getLatestSessionsByWorktree(state.sessions),
    [state.sessions]
  );
  const codexSessions = useMemo(
    () => buildCodexSessions(state.worktrees, latestSessionsByWorktree),
    [state.worktrees, latestSessionsByWorktree]
  );

  useEffect(() => {
    if (!bridge) {
      return undefined;
    }

    let mounted = true;

    const bootstrap = async () => {
      try {
        const initialState = await bridge.getState();
        if (!mounted) {
          return;
        }
        setState(initialState);
        if (initialState.worktrees.length > 0) {
          setSelectedWorktreeId(initialState.worktrees[0].id);
        }
      } catch (error) {
        setNotification((error as Error).message);
      }
    };

    bootstrap().catch((error) => {
      setNotification((error as Error).message);
    });

    const unsubscribeState = bridge.onStateUpdate((nextState) => {
      setState(nextState);
      setSelectedWorktreeId((current) => {
        if (current && nextState.worktrees.some((worktree) => worktree.id === current)) {
          return current;
        }
        return nextState.worktrees[0]?.id ?? null;
      });
    });

    return () => {
      mounted = false;
      unsubscribeState();
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge) {
      console.warn('[renderer] waiting for preload bridge…');
    }
  }, [bridge]);

  useEffect(() => {
    if (bridge) {
      return undefined;
    }

    const attach = () => {
      if (window.api) {
        setBridge(window.api);
      }
    };

    const intervalId = window.setInterval(attach, 100);
    window.addEventListener('electron-bridge-ready', attach);
    attach();

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('electron-bridge-ready', attach);
    };
  }, [bridge]);

  const runAction = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setNotification(null);
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      setNotification(message);
      console.error(error);
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const handleSelectProject = async () => {
    await runAction(async () => {
      const nextState = await api.selectProjectRoot();
      setState(nextState);
      changeWorktree(nextState.worktrees[0]?.id ?? null);
    });
  };

  const openCreateModal = () => {
    setNotification(null);
    setCreateName('');
    setCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    if (busy) {
      return;
    }
    setCreateModalOpen(false);
    setCreateName('');
  };

  const submitCreateWorktree = async () => {
    const trimmed = createName.trim();
    if (!trimmed) {
      setNotification('Feature name is required');
      return;
    }
    const descriptor = await runAction(() => api.createWorktree(trimmed));
    if (descriptor) {
      changeWorktree(descriptor.id);
      closeCreateModal();
    }
  };

  const handleCreateWorktreeKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitCreateWorktree();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeCreateModal();
    }
  };

  const handleMergeWorktree = async (worktree: WorktreeDescriptor) => {
    const confirmed = window.confirm(
      `Merge ${worktree.branch} into the main branch? Ensure commits are ready before proceeding.`
    );
    if (!confirmed) {
      return;
    }
    const nextState = await runAction(() => api.mergeWorktree(worktree.id));
    if (nextState) {
      setState(nextState);
      changeWorktree(worktree.id);
    }
  };

  const handleDeleteWorktree = async (worktree: WorktreeDescriptor) => {
    const confirmed = window.confirm(
      `Delete worktree ${worktree.featureName}? Changes inside ${worktree.path} will persist on disk.`
    );
    if (!confirmed) {
      return;
    }
    let deleteFolder = false;
    if (window.confirm('Also delete the worktree directory from disk? This cannot be undone.')) {
      deleteFolder = true;
    }
    const nextState = await runAction(() => api.removeWorktree(worktree.id, deleteFolder));
    if (nextState) {
      setState(nextState);
      if (!nextState.worktrees.some((item) => item.id === selectedWorktreeId)) {
        changeWorktree(nextState.worktrees[0]?.id ?? null);
      }
    }
  };

  const handleOpenWorktreeInVSCode = async (worktree: WorktreeDescriptor) => {
    await runAction(() => api.openWorktreeInVSCode(worktree.id));
  };

  const handleOpenWorktreeInGitGui = async (worktree: WorktreeDescriptor) => {
    await runAction(() => api.openWorktreeInGitGui(worktree.id));
  };

  const handleSidebarPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const divider = event.currentTarget as HTMLElement;
    const container = divider.parentElement;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const startX = event.clientX;
    const initialRatio = sidebarRatio;
    divider.setPointerCapture(event.pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const next = initialRatio + delta / rect.width;
      setPersistedSidebarRatio(next);
      moveEvent.preventDefault();
    };

    const handlePointerUp = () => {
      divider.releasePointerCapture(event.pointerId);
      divider.removeEventListener('pointermove', handlePointerMove);
      divider.removeEventListener('pointerup', handlePointerUp);
    };

    divider.addEventListener('pointermove', handlePointerMove);
    divider.addEventListener('pointerup', handlePointerUp, { once: true });
    event.preventDefault();
  }, [sidebarRatio, setPersistedSidebarRatio]);

  const renderCodexPane = useCallback(
    (worktree: WorktreeDescriptor, session: DerivedCodexSession | undefined) => {
      const isSelectedWorktree = worktree.id === selectedWorktreeId;
      const isActive = isSelectedWorktree && activeTab === 'codex';
      return (
        <div
          key={worktree.id}
          className="codex-pane-wrapper"
          style={{ display: isSelectedWorktree ? 'flex' : 'none' }}
        >
          <CodexPane
            api={api}
            bridge={bridge}
            worktree={worktree}
            session={session}
            active={isActive}
            onNotification={setNotification}
          />
        </div>
      );
    },
    [api, bridge, selectedWorktreeId, activeTab]
  );

  const renderTerminalPane = useCallback(
    (worktree: WorktreeDescriptor) => {
      const isSelectedWorktree = worktree.id === selectedWorktreeId;
      const isActive = isSelectedWorktree && activeTab === 'terminal';
      return (
        <div
          key={`${worktree.id}-terminal`}
          className="codex-pane-wrapper"
          style={{ display: isSelectedWorktree ? 'flex' : 'none' }}
        >
          <WorktreeTerminalPane
            api={api}
            worktree={worktree}
            active={isActive}
            onNotification={setNotification}
          />
        </div>
      );
    },
    [api, selectedWorktreeId, activeTab]
  );

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(worktreeTabStorageKey);
      if (stored === 'codex' || stored === 'terminal') {
        setActiveTab(stored);
      } else {
        setActiveTab(DEFAULT_TAB);
      }
    } catch (error) {
      console.warn('[layout] failed to load worktree tab', error);
      setActiveTab(DEFAULT_TAB);
    }
  }, [worktreeTabStorageKey]);

  const selectTab = useCallback(
    (tabId: WorktreeTabId) => {
      setActiveTab(tabId);
      try {
        window.localStorage.setItem(worktreeTabStorageKey, tabId);
      } catch (error) {
        console.warn('[layout] failed to persist worktree tab', error);
      }
    },
    [worktreeTabStorageKey]
  );

  if (!state.projectRoot) {
    return (
      <main className="empty-state">
        <div className="empty-card">
          <h1>Staremaster</h1>
          <p>Select a git repository to start coordinating worktrees and Codex sessions.</p>
          <button type="button" onClick={handleSelectProject} disabled={busy || !bridge}>
            Choose Project Folder
          </button>
          {notification ? <p className="banner banner-error">{notification}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <>
      <div className="app-shell" style={{ gridTemplateColumns: `${sidebarRatio * 100}% 6px 1fr` }}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <h2>Project</h2>
            <p title={state.projectRoot}>{state.projectRoot}</p>
          </div>
          <button type="button" onClick={handleSelectProject} disabled={busy || !bridge}>
            Switch
          </button>
        </div>
        <div className="sidebar-actions">
          <button
            type="button"
            onClick={openCreateModal}
            disabled={busy || !state.projectRoot || !bridge}
          >
            + New Worktree
          </button>
        </div>
        <div className="worktree-list">
          {state.worktrees.map((worktree) => {
            const isActive = worktree.id === selectedWorktreeId;
            return (
              <button
                key={worktree.id}
                type="button"
                className={`worktree-item ${isActive ? 'active' : ''}`}
                onClick={() => changeWorktree(worktree.id)}
                disabled={busy || !bridge}
              >
                <div className="worktree-name">{worktree.featureName}</div>
                <div className="worktree-meta">
                  <span className={`chip status-${worktree.status}`}>{worktree.status}</span>
                  <span className={`chip codex-${worktree.codexStatus}`}>Codex {worktree.codexStatus}</span>
                </div>
              </button>
            );
          })}
          {state.worktrees.length === 0 ? (
            <p className="worktree-empty">No worktrees yet. Create one to begin.</p>
          ) : null}
        </div>
      </aside>
      <div
        className="app-shell__divider"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={handleSidebarPointerDown}
      />
      <section className="main-pane">
        {notification ? <div className="banner banner-error">{notification}</div> : null}
        {selectedWorktree ? (
          <div className="worktree-overview">
            <header className="overview-header">
              <div>
                <h1>{selectedWorktree.featureName}</h1>
                <p>
                  Branch <code>{selectedWorktree.branch}</code>
                  {' · Path '}
                  <code title={selectedWorktree.path}>{selectedWorktree.path}</code>
                </p>
              </div>
              <div className="overview-actions">
                <button
                  type="button"
                  onClick={() => handleOpenWorktreeInVSCode(selectedWorktree)}
                  disabled={busy || !bridge}
                >
                  Open in VS Code
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenWorktreeInGitGui(selectedWorktree)}
                  disabled={busy || !bridge}
                >
                  Open in Git GUI
                </button>
                <button
                  type="button"
                  onClick={() => handleMergeWorktree(selectedWorktree)}
                  disabled={busy || !bridge}
                >
                  Merge
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteWorktree(selectedWorktree)}
                  disabled={busy || !bridge}
                >
                  Delete
                </button>
              </div>
            </header>
            <ResizableColumns
              left={
                <div className="worktree-tabs">
                  <div className="worktree-tabs__list" role="tablist" aria-label="Worktree panes">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab === 'codex'}
                      className={`worktree-tabs__button${activeTab === 'codex' ? ' worktree-tabs__button--active' : ''}`}
                      tabIndex={activeTab === 'codex' ? 0 : -1}
                      onClick={() => selectTab('codex')}
                    >
                      Codex
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab === 'terminal'}
                      className={`worktree-tabs__button${activeTab === 'terminal' ? ' worktree-tabs__button--active' : ''}`}
                      tabIndex={activeTab === 'terminal' ? 0 : -1}
                      onClick={() => selectTab('terminal')}
                    >
                      Terminal
                    </button>
                  </div>
                  <div className="worktree-tabs__panels">
                    <div
                      className={`worktree-tabs__panel${activeTab === 'codex' ? ' worktree-tabs__panel--active' : ''}`}
                      role="tabpanel"
                      aria-hidden={activeTab !== 'codex'}
                    >
                      <div className="codex-pane-collection">
                        {state.worktrees.map((worktree) =>
                          renderCodexPane(worktree, codexSessions.get(worktree.id))
                        )}
                      </div>
                    </div>
                    <div
                      className={`worktree-tabs__panel${activeTab === 'terminal' ? ' worktree-tabs__panel--active' : ''}`}
                      role="tabpanel"
                      aria-hidden={activeTab !== 'terminal'}
                    >
                      <div className="codex-pane-collection">
                        {state.worktrees.map((worktree) => renderTerminalPane(worktree))}
                      </div>
                    </div>
                  </div>
                </div>
              }
              right={
                <section className="diff-pane">
                  <GitPanel api={api} worktree={selectedWorktree} />
                </section>
              }
              storageKey={codexColumnsStorageKey}
            />
          </div>
        ) : (
          <div className="worktree-overview">
            <h1>Select a worktree</h1>
            <p>Choose a worktree on the left to view its Codex session and git changes.</p>
          </div>
        )}
      </section>
      </div>
      {isCreateModalOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={closeCreateModal}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-worktree-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="create-worktree-title">Create Worktree</h2>
            <p>Enter a feature name to create a new worktree.</p>
            <input
              type="text"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              onKeyDown={handleCreateWorktreeKeyDown}
              autoFocus
              placeholder="feature-name"
              disabled={busy}
            />
            <div className="modal-actions">
              <button type="button" onClick={closeCreateModal} disabled={busy}>
                Cancel
              </button>
              <button type="button" onClick={() => void submitCreateWorktree()} disabled={busy}>
                Create
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};

const createRendererStub = (): RendererApi => {
  const state: AppState = { ...EMPTY_STATE };
  const noop = () => {};

  return {
    getState: async () => state,
    selectProjectRoot: async () => state,
    createWorktree: async () => {
      throw new Error('Renderer API unavailable: createWorktree');
    },
    mergeWorktree: async () => state,
    removeWorktree: async (worktreeId, deleteFolder) => {
      void worktreeId;
      void deleteFolder;
      return state;
    },
    openWorktreeInVSCode: async () => undefined,
    openWorktreeInGitGui: async () => undefined,
    startCodex: async () => {
      throw new Error('Renderer API unavailable: startCodex');
    },
    stopCodex: async () => [],
    sendCodexInput: async () => undefined,
    onStateUpdate: (callback) => {
      void callback;
      return noop;
    },
    onCodexOutput: (callback) => {
      void callback;
      return noop;
    },
    onCodexStatus: (callback) => {
      void callback;
      return noop;
    },
    getGitStatus: async () => ({ staged: [], unstaged: [], untracked: [] }),
    getGitDiff: async (request) => ({
      filePath: request.filePath,
      staged: request.staged ?? false,
      diff: '',
      binary: false
    }),
    getCodexLog: async () => '',
    startWorktreeTerminal: async () => {
      throw new Error('Renderer API unavailable: startWorktreeTerminal');
    },
    stopWorktreeTerminal: async () => undefined,
    sendTerminalInput: async () => undefined,
    resizeTerminal: async () => undefined,
    onTerminalOutput: () => noop,
    onTerminalExit: () => noop
  };
};
