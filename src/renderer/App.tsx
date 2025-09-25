import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppState, WorktreeDescriptor, ProjectDescriptor } from '@shared/ipc';
import type { RendererApi } from '@shared/api';
import { GitPanel } from './components/GitPanel';
import { ResizableColumns } from './components/ResizableColumns';
import { CodexPane } from './components/CodexPane';
import {
  buildCodexSessions,
  getLatestSessionsByWorktree,
  DerivedCodexSession
} from './codex-model';

const EMPTY_STATE: AppState = {
  projects: [],
  worktrees: [],
  sessions: []
};

const SIDEBAR_MIN_RATIO = 0.1;
const SIDEBAR_MAX_RATIO = 0.28;

export const App: React.FC = () => {
  const [bridge, setBridge] = useState<RendererApi | null>(() => window.api ?? null);
  const api = useMemo(() => bridge ?? createRendererStub(), [bridge]);
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const [isCreateModalOpen, setCreateModalOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createProjectId, setCreateProjectId] = useState<string | null>(null);
  const [sidebarRatio, setSidebarRatio] = useState(0.25);
  const selectedProject = useMemo<ProjectDescriptor | null>(() => {
    if (!selectedProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === selectedProjectId) ?? null;
  }, [selectedProjectId, state.projects]);
  const projectKey = useMemo(
    () => (selectedProject ? encodeURIComponent(selectedProject.root) : 'global'),
    [selectedProject]
  );
  const sidebarStorageKey = useMemo(() => `layout/${projectKey}/sidebar-ratio`, [projectKey]);
  const codexColumnsStorageKey = useMemo(() => `layout/${projectKey}/codex-columns`, [projectKey]);

  const applyState = useCallback(
    (nextState: AppState, preferredProjectId?: string | null, preferredWorktreeId?: string | null) => {
      setState(nextState);

      const candidateProjectId = preferredProjectId ?? selectedProjectId;
      const resolvedProjectId = candidateProjectId && nextState.projects.some((project) => project.id === candidateProjectId)
        ? candidateProjectId
        : nextState.projects[0]?.id ?? null;

      const candidateWorktreeId = preferredWorktreeId ?? selectedWorktreeId;
      let resolvedWorktreeId = candidateWorktreeId && nextState.worktrees.some((worktree) => worktree.id === candidateWorktreeId)
        ? candidateWorktreeId
        : null;

      if (!resolvedWorktreeId && resolvedProjectId) {
        resolvedWorktreeId =
          nextState.worktrees.find((worktree) => worktree.projectId === resolvedProjectId)?.id ?? null;
      }

      setSelectedProjectId(resolvedProjectId);
      setSelectedWorktreeId(resolvedWorktreeId);
    },
    [selectedProjectId, selectedWorktreeId]
  );

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

  const changeWorktree = useCallback(
    (nextId: string | null, projectHint?: string) => {
      const resolvedProjectId = (() => {
        if (projectHint) {
          return projectHint;
        }
        if (!nextId) {
          return null;
        }
        return state.worktrees.find((worktree) => worktree.id === nextId)?.projectId ?? null;
      })();

      if (resolvedProjectId) {
        setSelectedProjectId(resolvedProjectId);
      }

      setSelectedWorktreeId((current) => {
        if (current && current === nextId) {
          return current;
        }
        return nextId;
      });
    },
    [state.worktrees]
  );

  const selectProject = useCallback(
    (projectId: string) => {
      setSelectedProjectId(projectId);
      setSelectedWorktreeId((current) => {
        if (current) {
          const descriptor = state.worktrees.find((item) => item.id === current);
          if (descriptor?.projectId === projectId) {
            return current;
          }
        }
        const fallback = state.worktrees.find((item) => item.projectId === projectId);
        return fallback?.id ?? null;
      });
    },
    [state.worktrees]
  );

  const selectedWorktree = useMemo<WorktreeDescriptor | null>(() => {
    if (!selectedWorktreeId) {
      return null;
    }
    return state.worktrees.find((worktree) => worktree.id === selectedWorktreeId) ?? null;
  }, [selectedWorktreeId, state.worktrees]);

  const worktreesByProject = useMemo(() => {
    const map = new Map<string, WorktreeDescriptor[]>();
    for (const worktree of state.worktrees) {
      const list = map.get(worktree.projectId);
      if (list) {
        list.push(worktree);
      } else {
        map.set(worktree.projectId, [worktree]);
      }
    }
    return map;
  }, [state.worktrees]);

  const modalProject = useMemo(() => {
    const targetId = createProjectId ?? selectedProjectId;
    if (!targetId) {
      return null;
    }
    return state.projects.find((project) => project.id === targetId) ?? null;
  }, [createProjectId, selectedProjectId, state.projects]);

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
        applyState(initialState);
      } catch (error) {
        setNotification((error as Error).message);
      }
    };

    bootstrap().catch((error) => {
      setNotification((error as Error).message);
    });

    const unsubscribeState = bridge.onStateUpdate((nextState) => {
      applyState(nextState);
    });

    return () => {
      mounted = false;
      unsubscribeState();
    };
  }, [applyState, bridge]);

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

  const handleAddProject = async () => {
    await runAction(async () => {
      const nextState = await api.addProject();
      const newProject = nextState.projects.find(
        (candidate) => !state.projects.some((existing) => existing.id === candidate.id)
      );
      applyState(nextState, newProject?.id ?? undefined);
    });
  };

  const openCreateModal = (projectId?: string) => {
    setNotification(null);
    setCreateName('');
    setCreateProjectId(projectId ?? selectedProjectId);
    setCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    if (busy) {
      return;
    }
    setCreateModalOpen(false);
    setCreateName('');
    setCreateProjectId(null);
  };

  const submitCreateWorktree = async () => {
    const trimmed = createName.trim();
    if (!trimmed) {
      setNotification('Feature name is required');
      return;
    }
    const targetProjectId = createProjectId ?? selectedProjectId;
    if (!targetProjectId) {
      setNotification('Select a project before creating a worktree');
      return;
    }
    const descriptor = await runAction(() => api.createWorktree(targetProjectId, trimmed));
    if (descriptor) {
      changeWorktree(descriptor.id, descriptor.projectId);
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

  const handleRemoveWorktree = async (worktree: WorktreeDescriptor) => {
    const confirmed = window.confirm(
      `Remove worktree ${worktree.featureName}? Changes inside ${worktree.path} will persist on disk.`,
    );
    if (!confirmed) {
      return;
    }
    const nextState = await runAction(() => api.removeWorktree(worktree.id));
    if (nextState) {
      applyState(nextState, worktree.projectId);
    }
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
      const isActive = worktree.id === selectedWorktreeId;
      return (
        <div
          key={worktree.id}
          className="codex-pane-wrapper"
          style={{ display: isActive ? 'flex' : 'none' }}
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
    [api, bridge, selectedWorktreeId]
  );

  if (state.projects.length === 0) {
    return (
      <main className="empty-state">
        <div className="empty-card">
          <h1>Staremaster</h1>
          <p>Add a git repository to start coordinating worktrees and Codex sessions.</p>
          <button type="button" onClick={handleAddProject} disabled={busy || !bridge}>
            Add Project
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
              <h2>Projects</h2>
              {selectedProject ? (
                <p title={selectedProject.root}>{selectedProject.root}</p>
              ) : (
                <p>No project selected</p>
              )}
            </div>
            <button type="button" onClick={handleAddProject} disabled={busy || !bridge}>
              Add new project
            </button>
          </div>
          <div className="project-list">
            {state.projects.map((project) => {
              const isProjectActive = project.id === selectedProject?.id;
              const projectWorktrees = worktreesByProject.get(project.id) ?? [];
              return (
                <div key={project.id} className={`project-group ${isProjectActive ? 'active' : ''}`}>
                  <div className="project-group-header">
                    <button
                      type="button"
                      className={`project-item ${isProjectActive ? 'active' : ''}`}
                      onClick={() => selectProject(project.id)}
                      disabled={busy || !bridge}
                      title={project.root}
                    >
                      <div className="project-name">{project.name}</div>
                      <div className="project-path">{project.root}</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => openCreateModal(project.id)}
                      disabled={busy || !bridge}
                      className="project-create"
                    >
                      + New Worktree
                    </button>
                  </div>
                  <div className="worktree-list">
                    {projectWorktrees.map((worktree) => {
                      const isActive = worktree.id === selectedWorktreeId;
                      return (
                        <button
                          key={worktree.id}
                          type="button"
                          className={`worktree-item ${isActive ? 'active' : ''}`}
                          onClick={() => changeWorktree(worktree.id, project.id)}
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
                    {projectWorktrees.length === 0 ? (
                      <p className="worktree-empty">No worktrees yet. Create one to begin.</p>
                    ) : null}
                  </div>
                </div>
              );
            })}
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
                    onClick={() => handleRemoveWorktree(selectedWorktree)}
                    disabled={busy || !bridge}
                  >
                    Remove
                  </button>
                </div>
              </header>
              <ResizableColumns
                left={
                  <div className="codex-pane-collection">
                    {state.worktrees.map((worktree) => renderCodexPane(worktree, codexSessions.get(worktree.id)))}
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
            <p>
              Enter a feature name to create a new worktree in{' '}
              {modalProject ? modalProject.name : 'the selected project'}.
            </p>
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
    addProject: async () => state,
    createWorktree: async (_projectId: string, _featureName: string) => {
      throw new Error('Renderer API unavailable: createWorktree');
    },
    removeWorktree: async (_worktreeId: string) => state,
    startCodex: async (_worktreeId: string) => {
      throw new Error('Renderer API unavailable: startCodex');
    },
    stopCodex: async (_worktreeId: string) => [],
    sendCodexInput: async (_worktreeId: string, _input: string) => undefined,
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
    getGitStatus: async (_worktreeId: string) => ({ staged: [], unstaged: [], untracked: [] }),
    getGitDiff: async (request) => ({
      filePath: request.filePath,
      staged: request.staged ?? false,
      diff: '',
      binary: false
    }),
    getCodexLog: async (_worktreeId: string) => ''
  };
};
