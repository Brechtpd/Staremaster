import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, WorktreeDescriptor, ProjectDescriptor } from '@shared/ipc';
import type { RendererApi } from '@shared/api';
import { GitPanel } from './components/GitPanel';
import { ResizableColumns } from './components/ResizableColumns';
import { CodexPane } from './components/CodexPane';
import { CodexTerminalShellPane } from './components/CodexTerminalShellPane';
import { WorktreeTerminalPane } from './components/WorktreeTerminalPane';
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
const DEFAULT_TAB = 'codex' as const;

type WorktreeTabId = 'codex' | 'terminal';
const CODEX_BUSY_WINDOW_MS = 1500;
const ECHO_BUFFER_LIMIT = 4096;

type CodexMode = 'custom' | 'terminal';
const DEFAULT_CODEX_MODE: CodexMode = 'terminal';

const ANSI_PATTERN = new RegExp(
  ['\\u001B\\[[0-9;?]*[ -/]*[@-~]', '\\u001B][^\\u0007]*\\u0007'].join('|'),
  'g'
);

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

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
  const worktreeTabStorageKey = useMemo(() => `layout/${projectKey}/worktree-tab`, [projectKey]);
  const [activeTab, setActiveTab] = useState<WorktreeTabId>(DEFAULT_TAB);
  const [codexActivity, setCodexActivity] = useState<Record<string, number>>({});
  const codexLastInputRef = useRef<Record<string, number>>({});
  const codexEchoBufferRef = useRef<Record<string, string>>({});
  const isTerminalCodex = DEFAULT_CODEX_MODE === 'terminal';

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

  useEffect(() => {
    const known = new Set(state.worktrees.map((worktree) => worktree.id));
    setCodexActivity((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      const now = Date.now();
      for (const id of Object.keys(prev)) {
        if (known.has(id) && now - prev[id] < CODEX_BUSY_WINDOW_MS * 2) {
          next[id] = prev[id];
        } else if (known.has(id)) {
          next[id] = 0;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    const inputEntries = codexLastInputRef.current;
    for (const id of Object.keys(inputEntries)) {
      if (!known.has(id)) {
        delete inputEntries[id];
      }
    }
    const echoEntries = codexEchoBufferRef.current;
    for (const id of Object.keys(echoEntries)) {
      if (!known.has(id)) {
        delete echoEntries[id];
      }
    }
  }, [state.worktrees]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCodexActivity((prev) => ({ ...prev }));
    }, 300);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

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

  const consumeEcho = useCallback((worktreeId: string, chunk: string): string => {
    const buffer = codexEchoBufferRef.current[worktreeId];
    if (!buffer || buffer.length === 0) {
      return chunk;
    }

    let bufferIndex = 0;
    let chunkIndex = 0;
    const bufferLength = buffer.length;

    while (chunkIndex < chunk.length && bufferIndex < bufferLength) {
      const chunkChar = chunk.charAt(chunkIndex);
      const bufferChar = buffer.charAt(bufferIndex);

      if (chunkChar === bufferChar) {
        chunkIndex += 1;
        bufferIndex += 1;
        continue;
      }

      if (chunkChar === '\r' || chunkChar === '\n') {
        chunkIndex += 1;
        continue;
      }

      if (bufferChar === '\r' || bufferChar === '\n') {
        bufferIndex += 1;
        continue;
      }

      break;
    }

    if (bufferIndex > 0) {
      if (bufferIndex >= bufferLength) {
        delete codexEchoBufferRef.current[worktreeId];
      } else {
        codexEchoBufferRef.current[worktreeId] = buffer.slice(bufferIndex);
      }
      return chunk.slice(chunkIndex);
    }

    return chunk;
  }, []);

  useEffect(() => {
    if (!bridge) {
      return undefined;
    }
    const unsubscribe = bridge.onCodexOutput((payload) => {
      const remainder = consumeEcho(payload.worktreeId, payload.chunk);
      if (!remainder) {
        return;
      }
      const normalized = remainder.replace(/\r/g, '');
      const visible = stripAnsi(normalized).trim();
      if (!visible) {
        return;
      }
      const now = Date.now();
      if (codexEchoBufferRef.current[payload.worktreeId]) {
        delete codexEchoBufferRef.current[payload.worktreeId];
      }
      setCodexActivity((prev) => ({ ...prev, [payload.worktreeId]: now }));
    });
    return unsubscribe;
  }, [bridge, consumeEcho]);

  useEffect(() => {
    const unsubscribe = api.onCodexTerminalOutput((payload) => {
      const remainder = consumeEcho(payload.worktreeId, payload.chunk);
      if (!remainder) {
        return;
      }
      const normalized = remainder.replace(/\r/g, '');
      const visible = stripAnsi(normalized).trim();
      if (!visible) {
        return;
      }
      const now = Date.now();
      setCodexActivity((prev) => ({ ...prev, [payload.worktreeId]: now }));
    });
    return unsubscribe;
  }, [api, consumeEcho]);

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

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(worktreeTabStorageKey);
      if (stored === 'terminal') {
        setActiveTab('terminal');
        return;
      }
    } catch (error) {
      console.warn('[layout] failed to load worktree tab', error);
    }
    setActiveTab(DEFAULT_TAB);
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

  const handleMergeWorktree = async (worktree: WorktreeDescriptor) => {
    const confirmed = window.confirm(
      `Merge ${worktree.branch} into the main branch? Ensure commits are ready before proceeding.`
    );
    if (!confirmed) {
      return;
    }
    const nextState = await runAction(() => api.mergeWorktree(worktree.id));
    if (nextState) {
      applyState(nextState, worktree.projectId, worktree.id);
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
      applyState(nextState, worktree.projectId);
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

  const handleCodexUserInput = useCallback((worktreeId: string, data: string) => {
    codexLastInputRef.current[worktreeId] = Date.now();
    if (!data) {
      return;
    }
    const existing = codexEchoBufferRef.current[worktreeId] ?? '';
    const next = (existing + data).slice(-ECHO_BUFFER_LIMIT);
    codexEchoBufferRef.current[worktreeId] = next;
  }, []);

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
          {isTerminalCodex ? (
            <CodexTerminalShellPane
              api={api}
              worktree={worktree}
              session={session}
              active={isActive}
              onNotification={setNotification}
              onUserInput={(data) => handleCodexUserInput(worktree.id, data)}
            />
          ) : (
            <CodexPane
              api={api}
              bridge={bridge}
              worktree={worktree}
              session={session}
              active={isActive}
              onNotification={setNotification}
              onUserInput={(data) => handleCodexUserInput(worktree.id, data)}
            />
          )}
        </div>
      );
    },
    [activeTab, api, bridge, handleCodexUserInput, isTerminalCodex, selectedWorktreeId, setNotification]
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
    [activeTab, api, selectedWorktreeId]
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
              const now = Date.now();
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
                      const session = codexSessions.get(worktree.id);
                      const lastActivity = codexActivity[worktree.id] ?? 0;
                      const isCodexBusy =
                        session?.status === 'running' && now - lastActivity < CODEX_BUSY_WINDOW_MS;
                      return (
                        <button
                          key={worktree.id}
                          type="button"
                          className={`worktree-item ${isActive ? 'active' : ''}`}
                          onClick={() => changeWorktree(worktree.id, project.id)}
                          disabled={busy || !bridge}
                        >
                          <div className="worktree-name">
                            {isCodexBusy ? (
                              <span className="worktree-spinner" aria-label="Codex processing" />
                            ) : (
                              <span className="worktree-idle-dot" aria-hidden="true" />
                            )}
                            {worktree.featureName}
                          </div>
                          <div className="worktree-meta">
                            <span className={`chip status-${worktree.status}`}>{worktree.status}</span>
                            <span className={`chip codex-${worktree.codexStatus}`}>
                              Codex {worktree.codexStatus}
                            </span>
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
                        className={`worktree-tabs__button${
                          activeTab === 'codex' ? ' worktree-tabs__button--active' : ''
                        }`}
                        tabIndex={activeTab === 'codex' ? 0 : -1}
                        onClick={() => selectTab('codex')}
                      >
                        Codex
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'terminal'}
                        className={`worktree-tabs__button${
                          activeTab === 'terminal' ? ' worktree-tabs__button--active' : ''
                        }`}
                        tabIndex={activeTab === 'terminal' ? 0 : -1}
                        onClick={() => selectTab('terminal')}
                      >
                        Terminal
                      </button>
                    </div>
                    <div className="worktree-tabs__panels">
                      <div
                        className={`worktree-tabs__panel${
                          activeTab === 'codex' ? ' worktree-tabs__panel--active' : ''
                        }`}
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
                        className={`worktree-tabs__panel${
                          activeTab === 'terminal' ? ' worktree-tabs__panel--active' : ''
                        }`}
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
    createWorktree: async (projectId: string, featureName: string) => {
      void projectId;
      void featureName;
      throw new Error('Renderer API unavailable: createWorktree');
    },
    mergeWorktree: async (_worktreeId?: string) => {
      void _worktreeId;
      return state;
    },
    removeWorktree: async (worktreeId: string, deleteFolder?: boolean) => {
      void worktreeId;
      void deleteFolder;
      return state;
    },
    openWorktreeInVSCode: async (worktreeId: string) => {
      void worktreeId;
      return undefined;
    },
    openWorktreeInGitGui: async (worktreeId: string) => {
      void worktreeId;
      return undefined;
    },
    startCodex: async (worktreeId: string) => {
      void worktreeId;
      throw new Error('Renderer API unavailable: startCodex');
    },
    stopCodex: async (worktreeId: string) => {
      void worktreeId;
      return [];
    },
    sendCodexInput: async (worktreeId: string, input: string) => {
      void worktreeId;
      void input;
      return undefined;
    },
    startCodexTerminal: async (worktreeId: string) => {
      void worktreeId;
      throw new Error('Renderer API unavailable: startCodexTerminal');
    },
    stopCodexTerminal: async (worktreeId: string) => {
      void worktreeId;
      return undefined;
    },
    sendCodexTerminalInput: async (worktreeId: string, data: string) => {
      void worktreeId;
      void data;
      return undefined;
    },
    resizeCodexTerminal: async (request) => {
      void request;
      return undefined;
    },
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
    getGitStatus: async (worktreeId: string) => {
      void worktreeId;
      return { staged: [], unstaged: [], untracked: [] };
    },
    getGitDiff: async (request) => ({
      filePath: request.filePath,
      staged: request.staged ?? false,
      diff: '',
      binary: false
    }),
    getCodexLog: async (worktreeId: string) => {
      void worktreeId;
      return '';
    },
    startWorktreeTerminal: async (worktreeId: string) => {
      void worktreeId;
      throw new Error('Renderer API unavailable: startWorktreeTerminal');
    },
    stopWorktreeTerminal: async (worktreeId: string) => {
      void worktreeId;
      return undefined;
    },
    sendTerminalInput: async (worktreeId: string, data: string) => {
      void worktreeId;
      void data;
      return undefined;
    },
    resizeTerminal: async (request) => {
      void request;
      return undefined;
    },
    onTerminalOutput: () => noop,
    onTerminalExit: () => noop,
    onCodexTerminalOutput: () => noop,
    onCodexTerminalExit: () => noop
  };
};
