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
const hiddenProjectsStorageKey = 'layout/hidden-projects';
const collapsedProjectsStorageKey = 'layout/collapsed-projects';
const sidebarRatioStorageKey = 'layout/sidebar-ratio';

export class LongRunTracker {
  constructor(private readonly thresholdMs: number) {}

  private readonly starts = new Map<string, number>();
  private readonly notified = new Set<string>();

  update(worktreeId: string, busy: boolean, timestamp: number): boolean {
    if (busy) {
      if (!this.starts.has(worktreeId)) {
        this.starts.set(worktreeId, timestamp);
        this.notified.delete(worktreeId);
      }
      return false;
    }

    const start = this.starts.get(worktreeId);
    if (start == null) {
      this.notified.delete(worktreeId);
      return false;
    }

    this.starts.delete(worktreeId);

    if (this.notified.has(worktreeId)) {
      return false;
    }

    if (timestamp - start >= this.thresholdMs) {
      this.notified.add(worktreeId);
      return true;
    }

    this.notified.delete(worktreeId);
    return false;
  }

  prune(validIds: Set<string>): void {
    for (const id of Array.from(this.starts.keys())) {
      if (!validIds.has(id)) {
        this.starts.delete(id);
      }
    }
    for (const id of Array.from(this.notified.values())) {
      if (!validIds.has(id)) {
        this.notified.delete(id);
      }
    }
  }
}

const computeBusyFlag = (params: {
  allowSpinner: boolean;
  lastActivity?: number;
  lastInput?: number;
  now: number;
}): boolean => {
  if (!params.allowSpinner) {
    return false;
  }
  const activity = params.lastActivity ?? 0;
  const input = params.lastInput ?? 0;
  if (activity === 0 || activity <= input) {
    return false;
  }
  return params.now - activity < CODEX_BUSY_WINDOW_MS;
};

const ANSI_PATTERN = new RegExp(
  ['\\u001B\\[[0-9;?]*[ -/]*[@-~]', '\\u001B][^\\u0007]*\\u0007'].join('|'),
  'g'
);

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const readStoredList = (key: string): string[] => {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch (error) {
    console.warn(`[layout] failed to parse stored list for ${key}`, error);
  }
  return [];
};

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
  const [hiddenProjectIds, setHiddenProjectIds] = useState<string[]>(() => readStoredList(hiddenProjectsStorageKey));
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>(() => readStoredList(collapsedProjectsStorageKey));
  const stateInitializedRef = useRef(false);
  const selectedProject = useMemo<ProjectDescriptor | null>(() => {
    if (!selectedProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === selectedProjectId) ?? null;
  }, [selectedProjectId, state.projects]);
  const hiddenProjects = useMemo(() => new Set(hiddenProjectIds), [hiddenProjectIds]);
  const collapsedProjects = useMemo(() => new Set(collapsedProjectIds), [collapsedProjectIds]);
  const visibleProjects = useMemo(
    () => state.projects.filter((project) => !hiddenProjects.has(project.id)),
    [hiddenProjects, state.projects]
  );
  const effectiveProject = useMemo(() => {
    if (selectedProject && !hiddenProjects.has(selectedProject.id)) {
      return selectedProject;
    }
    return visibleProjects[0] ?? null;
  }, [hiddenProjects, selectedProject, visibleProjects]);
  const projectKey = useMemo(
    () => (effectiveProject ? encodeURIComponent(effectiveProject.root) : 'global'),
    [effectiveProject]
  );
  const codexColumnsStorageKey = useMemo(() => `layout/${projectKey}/codex-columns`, [projectKey]);
  const worktreeTabStorageKey = useMemo(() => `layout/${projectKey}/worktree-tab`, [projectKey]);
  const [activeTab, setActiveTab] = useState<WorktreeTabId>(DEFAULT_TAB);
  const [codexActivity, setCodexActivity] = useState<Record<string, number>>({});
  const [codexStatusLines, setCodexStatusLines] = useState<Record<string, string>>({});
  const codexLastInputRef = useRef<Record<string, number>>({});
  const codexEchoBufferRef = useRef<Record<string, string>>({});
  const longRunTrackerRef = useRef(new LongRunTracker(10_000));
  const busyStatesRef = useRef<Array<{ id: string; busy: boolean }>>([]);
  const isTerminalCodex = DEFAULT_CODEX_MODE === 'terminal';
  const filteredWorktrees = useMemo(() => {
    if (state.projects.length === 0) {
      return state.worktrees;
    }
    const roots = new Map(state.projects.map((project) => [project.id, project.root] as const));
    return state.worktrees.filter((worktree) => {
      const root = roots.get(worktree.projectId);
      return !root || worktree.path !== root;
    });
  }, [state.projects, state.worktrees]);
  const busyStates: Array<{ id: string; busy: boolean }> = [];
  const busySignatureParts: string[] = [];
  const busyTimestamp = Date.now();
  const registerBusyState = (id: string, busy: boolean) => {
    busyStates.push({ id, busy });
    busySignatureParts.push(`${id}:${busy ? 1 : 0}`);
  };

  const captureStatusLine = useCallback((worktreeId: string, plainText: string) => {
    const lines = plainText.split(/\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const trimmed = lines[index].trim();
      if (!trimmed) {
        continue;
      }
      if (!/esc to interrupt/i.test(trimmed)) {
        continue;
      }
      const normalized = trimmed.replace(/\s+/g, ' ').trim();
      const summary = normalized
        .replace(/^[-•\s]+/, '')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim();
      setCodexStatusLines((prev) => {
        if (!summary) {
          if (!prev[worktreeId]) {
            return prev;
          }
          const next = { ...prev };
          delete next[worktreeId];
          return next;
        }
        if (prev[worktreeId] === summary) {
          return prev;
        }
        return { ...prev, [worktreeId]: summary };
      });
      return;
    }
  }, []);

  const pushDesktopNotification = useCallback((title: string, body: string) => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return;
    }
    const spawn = () => {
      try {
        // eslint-disable-next-line no-new
        new Notification(title, { body });
      } catch (error) {
        console.warn('[codex] notification failed', error);
      }
    };
    if (Notification.permission === 'granted') {
      spawn();
    } else if (Notification.permission === 'default') {
      Notification.requestPermission()
        .then((permission) => {
          if (permission === 'granted') {
            spawn();
          }
        })
        .catch((error) => {
          console.warn('[codex] notification permission request failed', error);
        });
    }
  }, []);

  const describeWorktree = useCallback(
    (worktreeId: string): { title: string; detail: string } => {
      const worktree = state.worktrees.find((item) => item.id === worktreeId);
      const projectIdFromRoot = worktreeId.startsWith('project-root:')
        ? worktreeId.slice('project-root:'.length)
        : null;
      const project = state.projects.find((item) => item.id === (worktree?.projectId ?? projectIdFromRoot));
      const featureName = worktree?.featureName ?? 'main';
      const title = project ? `${project.name} / ${featureName}` : featureName;
      const detail = codexStatusLines[worktreeId] ?? 'Codex finished processing.';
      return { title, detail };
    },
    [codexStatusLines, state.projects, state.worktrees]
  );

  const notifyLongRunCompletion = useCallback(
    (worktreeId: string) => {
      const { title, detail } = describeWorktree(worktreeId);
      pushDesktopNotification(title, detail);
    },
    [describeWorktree, pushDesktopNotification]
  );

  const applyState = useCallback(
    (nextState: AppState, preferredProjectId?: string | null, preferredWorktreeId?: string | null) => {
      if (stateInitializedRef.current) {
        const previousProjectIds = new Set(state.projects.map((project) => project.id));
        const newProjectIds = nextState.projects
          .filter((project) => !previousProjectIds.has(project.id))
          .map((project) => project.id);

        if (newProjectIds.length > 0) {
          setHiddenProjectIds((prev) => prev.filter((id) => !newProjectIds.includes(id)));
          setCollapsedProjectIds((prev) => prev.filter((id) => !newProjectIds.includes(id)));
        }
      }

      setState(nextState);

      const hiddenSet = new Set(hiddenProjectIds);
      const findFirstVisibleProjectId = () =>
        nextState.projects.find((project) => !hiddenSet.has(project.id))?.id ?? null;

      const candidateProjectId = preferredProjectId ?? selectedProjectId;
      const resolvedProjectId = candidateProjectId &&
        nextState.projects.some((project) => project.id === candidateProjectId && !hiddenSet.has(project.id))
        ? candidateProjectId
        : findFirstVisibleProjectId();

      const candidateWorktreeId = preferredWorktreeId ?? selectedWorktreeId;
      const isRootCandidate = candidateWorktreeId?.startsWith('project-root:') ?? false;
      let resolvedWorktreeId =
        candidateWorktreeId &&
        (isRootCandidate ||
          nextState.worktrees.some(
            (worktree) =>
              worktree.id === candidateWorktreeId &&
              (!resolvedProjectId || worktree.projectId === resolvedProjectId)
          ))
          ? candidateWorktreeId
          : null;

      if (!resolvedWorktreeId && resolvedProjectId) {
        const rootId = `project-root:${resolvedProjectId}`;
        const fallbackWorktree = nextState.worktrees.find((worktree) => worktree.projectId === resolvedProjectId);
        resolvedWorktreeId = fallbackWorktree?.id ?? rootId;
      }

      setSelectedProjectId(resolvedProjectId);
      setSelectedWorktreeId(resolvedWorktreeId);
      stateInitializedRef.current = true;
    },
    [hiddenProjectIds, selectedProjectId, selectedWorktreeId, state.projects]
  );

  useEffect(() => {
    const defaultRatio = Math.min(SIDEBAR_MAX_RATIO, Math.max(SIDEBAR_MIN_RATIO, 0.25));
    try {
      const stored = window.localStorage.getItem(sidebarRatioStorageKey);
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
  }, []);

  const setPersistedSidebarRatio = useCallback((value: number) => {
    const clamped = Math.min(SIDEBAR_MAX_RATIO, Math.max(SIDEBAR_MIN_RATIO, value));
    setSidebarRatio(clamped);
    try {
      window.localStorage.setItem(sidebarRatioStorageKey, clamped.toString());
    } catch (error) {
      console.warn('[layout] failed to persist sidebar ratio', error);
    }
  }, []);

  useEffect(() => {
    try {
      const storedHidden = window.localStorage.getItem(hiddenProjectsStorageKey);
      if (storedHidden) {
        const parsed = JSON.parse(storedHidden);
        if (Array.isArray(parsed)) {
          setHiddenProjectIds(parsed.filter((value): value is string => typeof value === 'string'));
        }
      }
    } catch (error) {
      console.warn('[layout] failed to load hidden projects', error);
    }
    try {
      const storedCollapsed = window.localStorage.getItem(collapsedProjectsStorageKey);
      if (storedCollapsed) {
        const parsed = JSON.parse(storedCollapsed);
        if (Array.isArray(parsed)) {
          setCollapsedProjectIds(parsed.filter((value): value is string => typeof value === 'string'));
        }
      }
    } catch (error) {
      console.warn('[layout] failed to load collapsed projects', error);
    }
  }, []);

  useEffect(() => {
    if (!stateInitializedRef.current) {
      return;
    }
    setHiddenProjectIds((prev) => {
      const valid = prev.filter((id) => state.projects.some((project) => project.id === id));
      return valid.length === prev.length ? prev : valid;
    });
  }, [state.projects]);

  useEffect(() => {
    if (!stateInitializedRef.current) {
      return;
    }
    setCollapsedProjectIds((prev) => {
      const valid = prev.filter((id) => state.projects.some((project) => project.id === id));
      return valid.length === prev.length ? prev : valid;
    });
  }, [state.projects]);

  useEffect(() => {
    try {
      window.localStorage.setItem(hiddenProjectsStorageKey, JSON.stringify(hiddenProjectIds));
    } catch (error) {
      console.warn('[layout] failed to persist hidden projects', error);
    }
  }, [hiddenProjectIds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify(collapsedProjectIds));
    } catch (error) {
      console.warn('[layout] failed to persist collapsed projects', error);
    }
  }, [collapsedProjectIds]);

  useEffect(() => {
    if (effectiveProject) {
      setSelectedProjectId((current) => (current === effectiveProject.id ? current : effectiveProject.id));
    } else if (selectedProjectId) {
      setSelectedProjectId(null);
    }
  }, [effectiveProject, selectedProjectId]);

  useEffect(() => {
    const known = new Set(state.worktrees.map((worktree) => worktree.id));
    for (const project of state.projects) {
      known.add(`project-root:${project.id}`);
    }
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
  }, [state.projects, state.worktrees]);

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
        setCollapsedProjectIds((prev) => prev.filter((id) => id !== resolvedProjectId));
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
      setCollapsedProjectIds((prev) => prev.filter((id) => id !== projectId));
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

  const toggleProjectCollapse = useCallback((projectId: string) => {
    setCollapsedProjectIds((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]
    );
  }, []);

  const handleHideProject = useCallback(
    (projectId: string) => {
      const nextHidden = new Set(hiddenProjects);
      nextHidden.add(projectId);
      const fallbackProjectId = state.projects.find((project) => !nextHidden.has(project.id))?.id ?? null;

      setHiddenProjectIds((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));
      setCollapsedProjectIds((prev) => prev.filter((id) => id !== projectId));

      setSelectedProjectId((current) => {
        if (current && !nextHidden.has(current) && current !== projectId) {
          return current;
        }
        return fallbackProjectId;
      });

      setSelectedWorktreeId((current) => {
        const currentDescriptor = state.worktrees.find((worktree) => worktree.id === current);
        if (currentDescriptor && !nextHidden.has(currentDescriptor.projectId) && currentDescriptor.projectId !== projectId) {
          return current;
        }
        if (!fallbackProjectId) {
          return null;
        }
        return state.worktrees.find((worktree) => worktree.projectId === fallbackProjectId)?.id ?? null;
      });
    },
    [hiddenProjects, state.projects, state.worktrees]
  );

  const rootWorktree = useMemo<WorktreeDescriptor | null>(() => {
    if (!selectedWorktreeId?.startsWith('project-root:')) {
      return null;
    }
    const projectId = selectedWorktreeId.slice('project-root:'.length);
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) {
      return null;
    }
    const representative = state.worktrees.find((item) => item.projectId === project.id);
    const branch = representative?.branch ?? 'main';
    return {
      id: selectedWorktreeId,
      projectId: project.id,
      featureName: 'main',
      branch,
      path: project.root,
      createdAt: project.createdAt,
      status: 'ready',
      codexStatus: 'idle'
    };
  }, [selectedWorktreeId, state.projects, state.worktrees]);

  const selectedWorktree = useMemo<WorktreeDescriptor | null>(() => {
    if (rootWorktree) {
      return rootWorktree;
    }
    if (!selectedWorktreeId) {
      return null;
    }
    return state.worktrees.find((worktree) => worktree.id === selectedWorktreeId) ?? null;
  }, [rootWorktree, selectedWorktreeId, state.worktrees]);

  const isRootSelection = Boolean(rootWorktree);

  const selectedWorktreeProject = useMemo<ProjectDescriptor | null>(() => {
    if (!selectedWorktree) {
      return null;
    }
    return state.projects.find((project) => project.id === selectedWorktree.projectId) ?? null;
  }, [selectedWorktree, state.projects]);

  const selectedWorktreeTitle = useMemo(() => {
    if (!selectedWorktree) {
      return '';
    }
    const projectName = selectedWorktreeProject?.name;
    return projectName ? `${projectName} / ${selectedWorktree.featureName}` : selectedWorktree.featureName;
  }, [selectedWorktree, selectedWorktreeProject]);

  const selectedWorktreeStatus = selectedWorktree ? codexStatusLines[selectedWorktree.id] ?? null : null;

  const renderableWorktrees = useMemo(() => {
    if (rootWorktree) {
      return [rootWorktree, ...filteredWorktrees];
    }
    return filteredWorktrees;
  }, [filteredWorktrees, rootWorktree]);

  const modalProject = useMemo(() => {
    const targetId = createProjectId ?? effectiveProject?.id ?? null;
    if (!targetId) {
      return null;
    }
    return state.projects.find((project) => project.id === targetId) ?? null;
  }, [createProjectId, effectiveProject, state.projects]);

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
      const plain = stripAnsi(normalized);
      captureStatusLine(payload.worktreeId, plain);
      if (!plain.trim()) {
        return;
      }
      const now = Date.now();
      if (codexEchoBufferRef.current[payload.worktreeId]) {
        delete codexEchoBufferRef.current[payload.worktreeId];
      }
      setCodexActivity((prev) => ({ ...prev, [payload.worktreeId]: now }));
    });
    return unsubscribe;
  }, [bridge, captureStatusLine, consumeEcho]);

  useEffect(() => {
    const unsubscribe = api.onCodexTerminalOutput((payload) => {
      const remainder = consumeEcho(payload.worktreeId, payload.chunk);
      if (!remainder) {
        return;
      }
      const normalized = remainder.replace(/\r/g, '');
      const plain = stripAnsi(normalized);
      captureStatusLine(payload.worktreeId, plain);
      if (!plain.trim()) {
        return;
      }
      const now = Date.now();
      setCodexActivity((prev) => ({ ...prev, [payload.worktreeId]: now }));
    });
    return unsubscribe;
  }, [api, captureStatusLine, consumeEcho]);

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
      if (!newProject) {
        const stillHidden = nextState.projects
          .filter((project) => hiddenProjects.has(project.id))
          .map((project) => project.id);
        if (stillHidden.length > 0) {
          setHiddenProjectIds((prev) => prev.filter((id) => !stillHidden.includes(id)));
          setCollapsedProjectIds((prev) => prev.filter((id) => !stillHidden.includes(id)));
        }
      }
    });
  };

  const openCreateModal = (projectId?: string) => {
    setNotification(null);
    setCreateName('');
    setCreateProjectId(projectId ?? effectiveProject?.id ?? null);
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
    const targetProjectId = createProjectId ?? effectiveProject?.id ?? null;
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
    if (worktree.id.startsWith('project-root:')) {
      setNotification('Cannot merge the main project worktree into itself.');
      return;
    }
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
    if (worktree.id.startsWith('project-root:')) {
      setNotification('The main project worktree cannot be deleted.');
      return;
    }
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

  const handleOpenWorktreeInFileManager = async (worktree: WorktreeDescriptor) => {
    await runAction(() => api.openWorktreeInFileManager(worktree.id));
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

  busyStatesRef.current = busyStates;
  const busySignature = busySignatureParts.sort().join('|');

  useEffect(() => {
    const tracker = longRunTrackerRef.current;
    const timestamp = Date.now();
    const snapshot = busyStatesRef.current;
    const validIds = new Set<string>();
    const idleIds: string[] = [];

    snapshot.forEach(({ id, busy }) => {
      validIds.add(id);
      if (!busy) {
        idleIds.push(id);
      }
      if (!tracker.update(id, busy, timestamp)) {
        return;
      }
      notifyLongRunCompletion(id);
    });

    setCodexStatusLines((prev) => {
      if (idleIds.length === 0 && prev && Object.keys(prev).every((key) => validIds.has(key))) {
        return prev;
      }
      let changed = false;
      const next = { ...prev };
      idleIds.forEach((id) => {
        if (next[id]) {
          delete next[id];
          changed = true;
        }
      });
      Object.keys(next).forEach((key) => {
        if (!validIds.has(key)) {
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    tracker.prune(validIds);
  }, [busySignature, notifyLongRunCompletion, setCodexStatusLines, setNotification, state.projects, state.worktrees]);

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
            </div>
            <button type="button" onClick={handleAddProject} disabled={busy || !bridge}>
              Add project
            </button>
          </div>
          <div className="project-list">
            {visibleProjects.map((project) => {
              const worktrees = filteredWorktrees
                .filter((worktree) => worktree.projectId === project.id)
                .sort((a, b) => a.featureName.localeCompare(b.featureName));
              const isCollapsed = collapsedProjects.has(project.id);
              const isActiveProject = worktrees.some((worktree) => worktree.id === selectedWorktreeId);
              const rootWorktreeId = `project-root:${project.id}`;
              const projectBranch = worktrees[0]?.branch ?? 'main';
              const isRootActive = selectedWorktreeId === rootWorktreeId;
              const entries = [
                { kind: 'root' as const, id: rootWorktreeId },
                ...worktrees.map((worktree) => ({ kind: 'worktree' as const, worktree }))
              ];

              return (
                <section
                  key={project.id}
                  className={`project-section${isActiveProject || isRootActive ? ' project-section--active' : ''}${isCollapsed ? ' project-section--collapsed' : ''}`}
                >
                  <header className="project-section__header">
                    <button
                      type="button"
                      className={`project-section__toggle${isCollapsed ? ' project-section__toggle--collapsed' : ''}`}
                      onClick={() => toggleProjectCollapse(project.id)}
                      aria-expanded={!isCollapsed}
                      aria-controls={`project-${project.id}-worktrees`}
                      aria-label={isCollapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
                    >
                      ▾
                    </button>
                    <div className="project-section__title-group">
                      <button
                        type="button"
                        className="project-section__title"
                        onClick={() => selectProject(project.id)}
                        disabled={busy || !bridge}
                        title={project.root}
                      >
                        <span className="project-section__name">{project.name}</span>
                      </button>
                    </div>
                    <div className="project-section__actions">
                      <button
                        type="button"
                        onClick={() => openCreateModal(project.id)}
                        disabled={busy || !bridge}
                      >
                        + Worktree
                      </button>
                      <button
                        type="button"
                        className="project-section__remove"
                        onClick={() => handleHideProject(project.id)}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </div>
                  </header>
                  {!isCollapsed ? (
                    <div
                      className="project-worktree-list"
                      role="tablist"
                      aria-label={`${project.name} worktrees`}
                      id={`project-${project.id}-worktrees`}
                    >
                      {entries.map((entry) => {
                        if (entry.kind === 'root') {
                          const isActive = selectedWorktreeId === entry.id;
                          const lastActivity = codexActivity[entry.id];
                          const lastUserInput = codexLastInputRef.current[entry.id] ?? 0;
                          const isBusy = computeBusyFlag({
                            allowSpinner: isTerminalCodex,
                            lastActivity,
                            lastInput: lastUserInput,
                            now: busyTimestamp
                          });
                          registerBusyState(entry.id, isBusy);
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              role="tab"
                              aria-selected={isActive}
                              className={`project-worktree project-worktree--root${isActive ? ' project-worktree--active' : ''}`}
                              onClick={() => changeWorktree(entry.id, project.id)}
                              disabled={busy || !bridge}
                            >
                              <span className="project-worktree__status">
                                {isBusy ? (
                                  <span className="worktree-spinner" role="img" aria-label="Codex processing" />
                                ) : (
                                  <span
                                    className="project-worktree__status-icon project-worktree__status-icon--root"
                                    aria-hidden="true"
                                  />
                                )}
                              </span>
                              <span className="project-worktree__name">main</span>
                              <span className="project-worktree__branch">{projectBranch}</span>
                            </button>
                          );
                        }

                        const worktree = entry.worktree;
                        const isActive = worktree.id === selectedWorktreeId;
                        const session = codexSessions.get(worktree.id);
                        const lastActivity = codexActivity[worktree.id];
                        const lastUserInput = codexLastInputRef.current[worktree.id] ?? 0;
                        const allowSpinner = session?.status === 'running' || isTerminalCodex;
                        const isCodexBusy = computeBusyFlag({
                          allowSpinner,
                          lastActivity,
                          lastInput: lastUserInput,
                          now: busyTimestamp
                        });
                        registerBusyState(worktree.id, isCodexBusy);
                        return (
                          <button
                            key={worktree.id}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            className={`project-worktree${isActive ? ' project-worktree--active' : ''}`}
                            onClick={() => changeWorktree(worktree.id, project.id)}
                            disabled={busy || !bridge}
                          >
                            <span className="project-worktree__status">
                              {isCodexBusy ? (
                                <span className="worktree-spinner" role="img" aria-label="Codex processing" />
                              ) : (
                                <span className="project-worktree__status-icon" aria-hidden="true" />
                              )}
                            </span>
                            <span className="project-worktree__name">{worktree.featureName}</span>
                            <span className="project-worktree__branch">{worktree.branch}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              );
            })}
            {visibleProjects.length === 0 ? (
              <p className="project-empty">No projects visible. Add a project to get started.</p>
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
                  <h1>{selectedWorktreeTitle}</h1>
                  {selectedWorktreeStatus ? (
                    <p className="overview-subtitle">{selectedWorktreeStatus}</p>
                  ) : null}
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
                    onClick={() => handleOpenWorktreeInFileManager(selectedWorktree)}
                    disabled={busy || !bridge}
                  >
                    Open Folder
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMergeWorktree(selectedWorktree)}
                    disabled={busy || !bridge || isRootSelection}
                  >
                    Merge
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteWorktree(selectedWorktree)}
                    disabled={busy || !bridge || isRootSelection}
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
                          {renderableWorktrees.map((worktree) =>
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
                          {renderableWorktrees.map((worktree) => renderTerminalPane(worktree))}
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
    openWorktreeInFileManager: async (worktreeId: string) => {
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
    startCodexTerminal: async (worktreeId: string, options?: { startupCommand?: string }) => {
      void worktreeId;
      void options;
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
