import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, WorktreeDescriptor, ProjectDescriptor, ThemePreference } from '@shared/ipc';
import type { RendererApi } from '@shared/api';
import type {
  OrchestratorBriefingInput,
  OrchestratorCommentInput,
  OrchestratorFollowUpInput
} from '@shared/orchestrator';
import { OrchestratorProvider } from './orchestrator/store';
import { GitPanel } from './components/GitPanel';
import { ResizableColumns } from './components/ResizableColumns';
import { CodexPane } from './components/CodexPane';
import { CodexTerminalShellPane } from './components/CodexTerminalShellPane';
import { WorktreeTerminalPane } from './components/WorktreeTerminalPane';
import { OrchestratorPane } from './components/OrchestratorPane';
import {
  buildCodexSessions,
  getLatestSessionsByWorktree,
  DerivedCodexSession,
  isInteractiveStatus
} from './codex-model';

const EMPTY_STATE: AppState = {
  projects: [],
  worktrees: [],
  sessions: [],
  preferences: { theme: 'light' }
};

const SIDEBAR_MIN_RATIO = 0.1;
const SIDEBAR_MAX_RATIO = 0.28;
const CODEX_BUSY_WINDOW_MS = 1500;
const CODEX_STATUS_IDLE_WINDOW_MS = 10_000;
const ECHO_BUFFER_LIMIT = 4096;
const SUMMARY_BUFFER_LIMIT = 4000;

type CodexMode = 'custom' | 'terminal';
const DEFAULT_CODEX_MODE: CodexMode = 'terminal';
const hiddenProjectsStorageKey = 'layout/hidden-projects';
const collapsedProjectsStorageKey = 'layout/collapsed-projects';
const sidebarRatioStorageKey = 'layout/sidebar-ratio';

type PaneKind = 'codex' | 'terminal' | 'orchestrator';

interface PaneInstance {
  id: string;
  kind: PaneKind;
  title: string;
  bootstrapped?: boolean;
}

const formatResumeCommand = (sessionId?: string | null): string =>
  sessionId ? `codex resume --yolo ${sessionId}` : '—';

interface PaneLayoutState {
  panes: PaneInstance[];
  activePaneId: string;
  showAll: boolean;
}

const paneLayoutStoragePrefix = 'layout/panes/';

type AppNotification = {
  kind: 'success' | 'error' | 'info';
  message: string;
};

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

const buildPaneStorageKey = (worktreeId: string): string =>
  `${paneLayoutStoragePrefix}${encodeURIComponent(worktreeId)}`;

const createPaneTitle = (kind: PaneKind, index: number): string => {
  const base =
    kind === 'codex' ? 'Codex' : kind === 'terminal' ? 'Terminal' : 'Orchestrator';
  return index === 0 ? base : `${base} ${index + 1}`;
};

const createPaneId = (worktreeId: string, kind: PaneKind): string => {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${worktreeId}:${kind}:${unique}`;
};

const createDefaultPaneLayout = (worktreeId: string): PaneLayoutState => {
  const codexPaneId = `${worktreeId}:codex:default`;
  const terminalPaneId = `${worktreeId}:terminal:default`;
  const orchestratorPaneId = `${worktreeId}:orchestrator:default`;
  const panes: PaneInstance[] = [
    { id: codexPaneId, kind: 'codex', title: createPaneTitle('codex', 0), bootstrapped: false },
    { id: terminalPaneId, kind: 'terminal', title: createPaneTitle('terminal', 0), bootstrapped: false },
    {
      id: orchestratorPaneId,
      kind: 'orchestrator',
      title: createPaneTitle('orchestrator', 0),
      bootstrapped: false
    }
  ];
  return { panes, activePaneId: codexPaneId, showAll: false };
};

const readStoredPaneLayout = (worktreeId: string): PaneLayoutState | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(buildPaneStorageKey(worktreeId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const panesValue = Array.isArray((parsed as { panes?: unknown }).panes)
      ? (parsed as { panes?: unknown }).panes
      : null;
    if (!panesValue) {
      return null;
    }
    const panes: PaneInstance[] = [];
    for (const candidate of panesValue) {
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }
      const rawCandidate = candidate as { id?: unknown; kind?: unknown; title?: unknown };
      const id = typeof rawCandidate.id === 'string' ? rawCandidate.id : null;
      const kind =
        rawCandidate.kind === 'codex' || rawCandidate.kind === 'terminal' || rawCandidate.kind === 'orchestrator'
          ? rawCandidate.kind
          : null;
      if (!id || !kind) {
        continue;
      }
      if (panes.some((pane) => pane.id === id)) {
        continue;
      }
      const existingCount = panes.filter((pane) => pane.kind === kind).length;
      const title =
        typeof rawCandidate.title === 'string' && rawCandidate.title
          ? rawCandidate.title
          : createPaneTitle(kind, existingCount);
      const bootstrapped = typeof rawCandidate.bootstrapped === 'boolean' ? rawCandidate.bootstrapped : false;
      panes.push({ id, kind, title, bootstrapped });
    }
    if (panes.length === 0) {
      return null;
    }
    if (!panes.some((pane) => pane.kind === 'orchestrator')) {
      const orchestratorPaneId = `${worktreeId}:orchestrator:${Date.now().toString(36)}`;
      panes.push({
        id: orchestratorPaneId,
        kind: 'orchestrator',
        title: createPaneTitle('orchestrator', 0),
        bootstrapped: false
      });
    }
    const activePaneId =
      typeof (parsed as { activePaneId?: unknown }).activePaneId === 'string'
        ? (parsed as { activePaneId?: string }).activePaneId
        : panes[0].id;
    const resolvedActive = panes.some((pane) => pane.id === activePaneId) ? activePaneId : panes[0].id;
    const showAll = Boolean((parsed as { showAll?: unknown }).showAll);
    return { panes, activePaneId: resolvedActive, showAll };
  } catch (error) {
    console.warn(`[layout] failed to parse pane layout for ${worktreeId}`, error);
    return null;
  }
};

const serializePaneLayout = (layout: PaneLayoutState): PaneLayoutState => ({
  ...layout,
  panes: layout.panes.map((pane) => ({
    id: pane.id,
    kind: pane.kind,
    title: pane.title,
    bootstrapped: pane.bootstrapped ?? false
  }))
});

const persistPaneLayout = (worktreeId: string, layout: PaneLayoutState): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(buildPaneStorageKey(worktreeId), JSON.stringify(serializePaneLayout(layout)));
  } catch (error) {
    console.warn('[layout] failed to persist pane layout', error);
  }
};

const removeStoredPaneLayout = (worktreeId: string): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem(buildPaneStorageKey(worktreeId));
  } catch (error) {
    console.warn('[layout] failed to remove pane layout', error);
  }
};

export const App: React.FC = () => {
  const [bridge, setBridge] = useState<RendererApi | null>(() => window.api ?? null);
  const api = useMemo(() => bridge ?? createRendererStub(), [bridge]);
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notification, setNotification] = useState<AppNotification | null>(null);
  const [isCreateModalOpen, setCreateModalOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createProjectId, setCreateProjectId] = useState<string | null>(null);
  const [sidebarRatio, setSidebarRatio] = useState(0.25);
  const [hiddenProjectIds, setHiddenProjectIds] = useState<string[]>(() => readStoredList(hiddenProjectsStorageKey));
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>(() => readStoredList(collapsedProjectsStorageKey));
  const [pullReadiness, setPullReadiness] = useState<Record<string, { clean: boolean; message?: string }>>({});
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
  const [paneLayouts, setPaneLayouts] = useState<Record<string, PaneLayoutState>>({});
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [renderedWorktreeIds, setRenderedWorktreeIds] = useState<string[]>([]);
  const [openPaneMenuFor, setOpenPaneMenuFor] = useState<string | null>(null);
  const bootstrappedPaneIdsRef = useRef<Set<string>>(new Set());
  const codexScrollStateRef = useRef<Record<string, { position: number; atBottom: boolean }>>({});
  const terminalScrollStateRef = useRef<Record<string, { position: number; atBottom: boolean }>>({});
  const worktreeCacheRef = useRef<Record<string, WorktreeDescriptor>>({});
  const [codexActivity, setCodexActivity] = useState<Record<string, number>>({});
  const [codexStatusLines, setCodexStatusLines] = useState<Record<string, string>>({});
  const codexLastInputRef = useRef<Record<string, number>>({});
  const codexEchoBufferRef = useRef<Record<string, string>>({});
  const codexStatusHeartbeatRef = useRef<Record<string, number>>({});
  const codexSummaryBufferRef = useRef<Record<string, string>>({});
  const longRunTrackerRef = useRef(new LongRunTracker(10_000));
  const busyStatesRef = useRef<Array<{ id: string; busy: boolean; running: boolean }>>([]);
  const codexBusyFlagRef = useRef<Record<string, boolean>>({});
  const codexRunningFlagRef = useRef<Record<string, boolean>>({});
  const appliedThemeRef = useRef<ThemePreference | null>(null);

  const applyThemePreference = useCallback((nextTheme: ThemePreference) => {
    if (typeof document === 'undefined') {
      appliedThemeRef.current = nextTheme;
      return;
    }
    if (appliedThemeRef.current === nextTheme) {
      return;
    }
    appliedThemeRef.current = nextTheme;
    const root = document.documentElement;
    root.dataset.theme = nextTheme;
    root.style.setProperty('color-scheme', nextTheme === 'dark' ? 'dark' : 'light');
    if (document.body) {
      document.body.dataset.theme = nextTheme;
    }
  }, []);

  useEffect(() => {
    applyThemePreference(state.preferences.theme);
  }, [applyThemePreference, state.preferences.theme]);
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

  const projectRootDescriptors = useMemo(() => {
    if (state.projects.length === 0 || state.worktrees.length === 0) {
      return new Map<string, WorktreeDescriptor>();
    }
    const roots = new Map(state.projects.map((project) => [project.id, project.root] as const));
    const descriptors = new Map<string, WorktreeDescriptor>();
    for (const worktree of state.worktrees) {
      const expectedRoot = roots.get(worktree.projectId);
      if (expectedRoot && worktree.path === expectedRoot) {
        descriptors.set(worktree.projectId, worktree);
      }
    }
    return descriptors;
  }, [state.projects, state.worktrees]);
  const orchestratorWorktreeIds = useMemo(
    () => state.worktrees.map((worktree) => worktree.id),
    [state.worktrees]
  );
  const busyStates: Array<{ id: string; busy: boolean; running: boolean }> = [];
  const busySignatureParts: string[] = [];
  const busyTimestamp = Date.now();
  const registerBusyState = (id: string, busy: boolean, running = false) => {
    busyStates.push({ id, busy, running });
    busySignatureParts.push(`${id}:${busy ? 1 : 0}:${running ? 1 : 0}`);
    const previousBusy = codexBusyFlagRef.current[id] ?? false;
    codexBusyFlagRef.current[id] = busy;
    if (busy && !previousBusy) {
      delete codexSummaryBufferRef.current[id];
    }
    const previousRunning = codexRunningFlagRef.current[id] ?? false;
    codexRunningFlagRef.current[id] = running;
    if (running && !previousRunning) {
      delete codexSummaryBufferRef.current[id];
    }
  };

  const appendSummaryBuffer = useCallback((worktreeId: string, chunk: string) => {
    if (!chunk) {
      return;
    }
    const existing = codexSummaryBufferRef.current[worktreeId] ?? '';
    const combined = existing ? `${existing}${chunk}` : chunk;
    codexSummaryBufferRef.current[worktreeId] =
      combined.length > SUMMARY_BUFFER_LIMIT ? combined.slice(combined.length - SUMMARY_BUFFER_LIMIT) : combined;
  }, []);

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

      let sanitized = trimmed;
      sanitized = sanitized.replace(/▌.*$/u, '');
      sanitized = sanitized.replace(/;(?=\S)/g, '; ');
      sanitized = sanitized.replace(/([0-9])([A-Za-z])/g, '$1 $2');
      sanitized = sanitized.replace(/([a-z])([A-Z])/g, '$1 $2');
      const match = sanitized.match(/^(.*?)(?:\(\s*[^)]*Esc to interrupt[^)]*\).*)$/i);
      let candidateText = match ? match[1] : sanitized.replace(/Esc to interrupt.*$/i, '');
      candidateText = candidateText.replace(/([0-9])([A-Za-z])/g, '$1 $2');
      candidateText = candidateText.replace(/([a-z])([A-Z])/g, '$1 $2');
      candidateText = candidateText.replace(/\s+/g, ' ').trim();
      const parts = candidateText
        .split(/(?:;|•|\||›)+/u)
        .map((part) => part.trim())
        .filter(Boolean);
      const candidate = parts.length > 0 ? parts[parts.length - 1] : candidateText;
      const summary = candidate.replace(/^[0-9]+[\s.:_-]*/, '').trim();

      if (!summary) {
        delete codexStatusHeartbeatRef.current[worktreeId];
        setCodexStatusLines((prev) => {
          if (!prev[worktreeId]) {
            return prev;
          }
          const next = { ...prev };
          delete next[worktreeId];
          return next;
        });
        return;
      }

      codexStatusHeartbeatRef.current[worktreeId] = Date.now();

      setCodexStatusLines((prev) => {
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
    async (worktreeId: string) => {
      const { title, detail: fallbackDetail } = describeWorktree(worktreeId);
      let detail = fallbackDetail;
      const bufferedOutput = codexSummaryBufferRef.current[worktreeId];
      if (bufferedOutput && api?.summarizeCodexOutput) {
        try {
          const summary = await api.summarizeCodexOutput(worktreeId, bufferedOutput);
          if (summary.trim()) {
            detail = summary.trim();
          }
        } catch (error) {
          console.warn('[codex] notification summary failed', error);
        }
      }
      delete codexSummaryBufferRef.current[worktreeId];
      pushDesktopNotification(title, detail);
    },
    [api, describeWorktree, pushDesktopNotification]
  );

  const applyState = useCallback(
    (nextState: AppState, preferredProjectId?: string | null, preferredWorktreeId?: string | null) => {
      applyThemePreference(nextState.preferences.theme);
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
    [applyThemePreference, hiddenProjectIds, selectedProjectId, selectedWorktreeId, state.projects]
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
    const statusHeartbeatEntries = codexStatusHeartbeatRef.current;
    for (const id of Object.keys(statusHeartbeatEntries)) {
      if (!known.has(id)) {
        delete statusHeartbeatEntries[id];
      }
    }
    const summaryEntries = codexSummaryBufferRef.current;
    for (const id of Object.keys(summaryEntries)) {
      if (!known.has(id)) {
        delete summaryEntries[id];
      }
    }
    const busyEntries = codexBusyFlagRef.current;
    for (const id of Object.keys(busyEntries)) {
      if (!known.has(id)) {
        delete busyEntries[id];
      }
    }
    const runningEntries = codexRunningFlagRef.current;
    for (const id of Object.keys(runningEntries)) {
      if (!known.has(id)) {
        delete runningEntries[id];
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

  const resolveSessionWorktreeId = useCallback(
    (worktreeId: string): string | null => {
      if (!worktreeId.startsWith('project-root:')) {
        return worktreeId;
      }
      const projectId = worktreeId.slice('project-root:'.length);
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return null;
      }
      const candidates = state.worktrees.filter((item) => item.projectId === projectId);
      if (candidates.length === 0) {
        return null;
      }
      if (project.defaultWorktreeId) {
        const preferred = candidates.find((item) => item.id === project.defaultWorktreeId);
        if (preferred) {
          return preferred.id;
        }
      }
      const sorted = [...candidates].sort((a, b) => {
        const aTime = Date.parse(a.createdAt ?? '');
        const bTime = Date.parse(b.createdAt ?? '');
        return bTime - aTime;
      });
      return sorted[0]?.id ?? null;
    },
    [state.projects, state.worktrees]
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

  const rootWorktree = useMemo<WorktreeDescriptor | null>(() => {
    if (!selectedWorktreeId?.startsWith('project-root:')) {
      return null;
    }
    const projectId = selectedWorktreeId.slice('project-root:'.length);
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) {
      return null;
    }
    const rootDescriptor = projectRootDescriptors.get(projectId);
    const canonicalId = resolveSessionWorktreeId(selectedWorktreeId);
    const canonical = canonicalId
      ? state.worktrees.find((item) => item.id === canonicalId)
      : undefined;
    const branch = rootDescriptor?.branch ?? canonical?.branch ?? 'main';
    const status = rootDescriptor?.status ?? canonical?.status ?? 'ready';
    const codexStatus = canonical?.codexStatus ?? rootDescriptor?.codexStatus ?? 'idle';
    const lastError = canonical?.lastError ?? rootDescriptor?.lastError;
    return {
      id: selectedWorktreeId,
      projectId: project.id,
      featureName: rootDescriptor?.featureName ?? 'main',
      branch,
      path: project.root,
      createdAt: rootDescriptor?.createdAt ?? project.createdAt,
      status,
      codexStatus,
      lastError
    };
  }, [
    projectRootDescriptors,
    resolveSessionWorktreeId,
    selectedWorktreeId,
    state.projects,
    state.worktrees
  ]);

  const selectedWorktree = useMemo<WorktreeDescriptor | null>(() => {
    if (rootWorktree) {
      return rootWorktree;
    }
    if (!selectedWorktreeId) {
      return null;
    }
    return state.worktrees.find((worktree) => worktree.id === selectedWorktreeId) ?? null;
  }, [rootWorktree, selectedWorktreeId, state.worktrees]);

  useEffect(() => {
    if (!selectedWorktree) {
      return;
    }
    setRenderedWorktreeIds((prev) => (prev.includes(selectedWorktree.id) ? prev : [...prev, selectedWorktree.id]));
  }, [selectedWorktree]);

  useEffect(() => {
    if (renderedWorktreeIds.length === 0) {
      return;
    }
    setPaneLayouts((prev) => {
      let mutated = false;
      const next = { ...prev };
      renderedWorktreeIds.forEach((worktreeId) => {
        if (!next[worktreeId]) {
          const stored = readStoredPaneLayout(worktreeId);
          next[worktreeId] = stored ?? createDefaultPaneLayout(worktreeId);
          mutated = true;
        }
      });
      return mutated ? next : prev;
    });
  }, [renderedWorktreeIds]);

  useEffect(() => {
    const next = new Set(bootstrappedPaneIdsRef.current);
    Object.values(paneLayouts).forEach((layout) => {
      layout.panes.forEach((pane) => {
        if (pane.bootstrapped) {
          next.add(pane.id);
        }
      });
    });
    bootstrappedPaneIdsRef.current = next;
  }, [paneLayouts]);

  useEffect(() => {
    if (!selectedWorktree) {
      return;
    }
    const worktreeId = selectedWorktree.id;
    setPaneLayouts((prev) => {
      if (prev[worktreeId]) {
        return prev;
      }
      const stored = readStoredPaneLayout(worktreeId);
      const layout = stored ?? createDefaultPaneLayout(worktreeId);
      if (!stored) {
        persistPaneLayout(worktreeId, layout);
      }
      return { ...prev, [worktreeId]: layout };
    });
  }, [selectedWorktree]);

  useEffect(() => {
    const validIds = new Set<string>();
    state.worktrees.forEach((worktree) => validIds.add(worktree.id));
    state.projects.forEach((project) => validIds.add(`project-root:${project.id}`));
    if (openPaneMenuFor && !validIds.has(openPaneMenuFor)) {
      setOpenPaneMenuFor(null);
    }
  }, [openPaneMenuFor, state.projects, state.worktrees]);

  const isRootSelection = Boolean(rootWorktree);
  const selectedWorktreeStatus = selectedWorktree?.status ?? 'idle';
  const isPulling = selectedWorktreeStatus === 'pulling';
  const isMerging = selectedWorktreeStatus === 'merging';
  const selectedPullInfo = selectedWorktree ? pullReadiness[selectedWorktree.id] : undefined;
  const pullButtonDisabled =
    busy || !bridge || isRootSelection || isPulling || isMerging || !(selectedPullInfo?.clean ?? false);
  const mergeButtonDisabled = busy || !bridge || isRootSelection || isPulling || isMerging;
  const pullHelperText = useMemo(() => {
    if (busy && !isPulling && !isMerging) {
      return 'Another action is currently running. Pull will be available once it completes.';
    }
    if (!selectedWorktree || isRootSelection) {
      return 'Select a feature worktree to enable pulling from main.';
    }
    if (isPulling) {
      return 'Pull in progress…';
    }
    if (isMerging) {
      return 'Merge in progress. Pull will be available afterwards.';
    }
    if (selectedPullInfo?.clean) {
      return null;
    }
    if (!selectedPullInfo) {
      return 'Checking worktree status…';
    }
    return selectedPullInfo.message ?? 'Pull requires a clean worktree.';
  }, [busy, isMerging, isPulling, isRootSelection, selectedPullInfo, selectedWorktree]);

  const worktreeStatusLabel = useMemo(() => {
    if (!selectedWorktree) {
      return null;
    }
    switch (selectedWorktree.status) {
      case 'pulling':
        return 'Pulling latest main branch changes…';
      case 'merging':
        return 'Merging into the main branch…';
      case 'error':
        return selectedWorktree.lastError ?? 'Worktree reported an error.';
      default:
        return null;
    }
  }, [selectedWorktree]);

  const pullButtonTitle = pullHelperText ?? 'Pull latest main branch changes into this worktree.';
  const mergeButtonTitle = useMemo(() => {
    if (isRootSelection) {
      return 'Merge is unavailable for the main project view.';
    }
    if (isPulling) {
      return 'Wait for the pull operation to finish before merging.';
    }
    if (isMerging) {
      return 'A merge is already in progress.';
    }
    return 'Merge this worktree into the main branch.';
  }, [isMerging, isPulling, isRootSelection]);

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

  const modalProject = useMemo(() => {
    const targetId = createProjectId ?? effectiveProject?.id ?? null;
    if (!targetId) {
      return null;
    }
    return state.projects.find((project) => project.id === targetId) ?? null;
  }, [createProjectId, effectiveProject, state.projects]);

  const resolveWorktreeDescriptor = useCallback(
    (worktreeId: string): WorktreeDescriptor | null => {
      if (worktreeId.startsWith('project-root:')) {
        const projectId = worktreeId.slice('project-root:'.length);
        const project = state.projects.find((item) => item.id === projectId);
        if (!project) {
          return worktreeCacheRef.current[worktreeId] ?? null;
        }
        const representative = state.worktrees.find((item) => item.projectId === projectId);
        const branch = representative?.branch ?? 'main';
        const descriptor: WorktreeDescriptor = {
          id: worktreeId,
          projectId,
          featureName: 'main',
          branch,
          path: project.root,
          createdAt: project.createdAt,
          status: 'ready',
          codexStatus: 'idle'
        };
        worktreeCacheRef.current[worktreeId] = descriptor;
        return descriptor;
      }

      const fromState = state.worktrees.find((item) => item.id === worktreeId);
      if (fromState) {
        worktreeCacheRef.current[worktreeId] = fromState;
        return fromState;
      }

      return worktreeCacheRef.current[worktreeId] ?? null;
    },
    [state.projects, state.worktrees]
  );

  const visitedWorktreeIds = useMemo(() => {
    const ids = new Set(renderedWorktreeIds);
    if (selectedWorktree) {
      ids.add(selectedWorktree.id);
    }
    return Array.from(ids);
  }, [renderedWorktreeIds, selectedWorktree]);

  const updatePaneLayout = useCallback(
    (worktreeId: string, updater: (current: PaneLayoutState) => PaneLayoutState) => {
      setPaneLayouts((prev) => {
        const base = prev[worktreeId] ?? readStoredPaneLayout(worktreeId) ?? createDefaultPaneLayout(worktreeId);
        const next = updater(base);
        if (next === base) {
          return prev;
        }
        const serialized = serializePaneLayout(next);
        const updated = { ...prev, [worktreeId]: serialized };
        persistPaneLayout(worktreeId, serialized);
        return updated;
      });
    },
    []
  );

  const handleActivatePane = useCallback(
    (worktreeId: string, paneId: string) => {
      updatePaneLayout(worktreeId, (current) => {
        if (current.activePaneId === paneId) {
          return current;
        }
        return { ...current, activePaneId: paneId };
      });
    },
    [updatePaneLayout]
  );

  const markPaneBootstrapped = useCallback((worktreeId: string, paneId: string) => {
    console.log('[renderer] pane bootstrapped', { worktreeId, paneId });
    bootstrappedPaneIdsRef.current.add(paneId);
    updatePaneLayout(worktreeId, (current) => {
      let mutated = false;
      const panes = current.panes.map((pane) => {
        if (pane.id === paneId && pane.bootstrapped !== true) {
          mutated = true;
          return { ...pane, bootstrapped: true };
        }
        return pane;
      });
      return mutated ? { ...current, panes } : current;
    });
    bootstrappedPaneIdsRef.current.add(paneId);
  }, [updatePaneLayout]);

  const markPaneUnbootstrapped = useCallback((worktreeId: string, paneId: string) => {
    updatePaneLayout(worktreeId, (current) => {
      let mutated = false;
      const panes = current.panes.map((pane) => {
        if (pane.id === paneId && pane.bootstrapped === true) {
          mutated = true;
          return { ...pane, bootstrapped: false };
        }
        return pane;
      });
      return mutated ? { ...current, panes } : current;
    });
    bootstrappedPaneIdsRef.current.delete(paneId);
  }, [updatePaneLayout]);

  const handleAddPane = useCallback(
    (worktreeId: string, kind: PaneKind) => {
      const layout = paneLayouts[worktreeId] ?? createDefaultPaneLayout(worktreeId);
      if (kind === 'orchestrator') {
        const existing = layout.panes.find((pane) => pane.kind === 'orchestrator');
        if (existing) {
          updatePaneLayout(worktreeId, (current) => ({ ...current, activePaneId: existing.id }));
          setOpenPaneMenuFor(null);
          return;
        }
      }
      const sameKindCount = layout.panes.filter((pane) => pane.kind === kind).length;
      const newPane: PaneInstance = {
        id: createPaneId(worktreeId, kind),
        kind,
        title: createPaneTitle(kind, sameKindCount),
        bootstrapped: false
      };
      bootstrappedPaneIdsRef.current.delete(newPane.id);
      updatePaneLayout(worktreeId, (current) => ({
        ...current,
        panes: [...current.panes, newPane],
        activePaneId: newPane.id
      }));
      setOpenPaneMenuFor(null);
    },
    [paneLayouts, updatePaneLayout]
  );

  const handleRemovePane = useCallback(
    (worktreeId: string, pane: PaneInstance) => {
      const layout = paneLayouts[worktreeId] ?? createDefaultPaneLayout(worktreeId);
      if (layout.panes.length <= 1 || !layout.panes.some((item) => item.id === pane.id)) {
        return;
      }
      updatePaneLayout(worktreeId, (current) => {
        const panes = current.panes.filter((item) => item.id !== pane.id);
        const nextActiveId =
          current.activePaneId === pane.id ? panes[panes.length - 1]?.id ?? panes[0]?.id ?? '' : current.activePaneId;
        return {
          ...current,
          panes,
          activePaneId: nextActiveId || (panes[0]?.id ?? '')
        };
      });
      bootstrappedPaneIdsRef.current.delete(pane.id);
      delete codexScrollStateRef.current[pane.id];
      delete terminalScrollStateRef.current[pane.id];
      if (pane.kind === 'codex' || pane.kind === 'terminal') {
        void api.stopWorktreeTerminal(worktreeId, { paneId: pane.id }).catch((error) => {
          console.warn('[pane] failed to stop terminal session', error);
        });
      }
    },
    [api, paneLayouts, updatePaneLayout]
  );

  const handleToggleShowAll = useCallback(
    (worktreeId: string) => {
      updatePaneLayout(worktreeId, (current) => ({ ...current, showAll: !current.showAll }));
    },
    [updatePaneLayout]
  );

  const handlePaneMenuToggle = useCallback((worktreeId: string) => {
    setOpenPaneMenuFor((prev) => (prev === worktreeId ? null : worktreeId));
  }, []);

  const latestSessionsByWorktree = useMemo(
    () => getLatestSessionsByWorktree(state.sessions),
    [state.sessions]
  );
  const codexSessions = useMemo(
    () => buildCodexSessions(state.worktrees, latestSessionsByWorktree),
    [state.worktrees, latestSessionsByWorktree]
  );

  useEffect(() => {
    if (!openPaneMenuFor) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.closest('.pane-strip__add')) {
        setOpenPaneMenuFor(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenPaneMenuFor(null);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openPaneMenuFor]);

  useEffect(() => {
    setOpenPaneMenuFor(null);
  }, [selectedWorktree]);

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
      appendSummaryBuffer(payload.worktreeId, plain);
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
  }, [appendSummaryBuffer, bridge, captureStatusLine, consumeEcho]);

  useEffect(() => {
    const unsubscribe = api.onTerminalOutput((payload) => {
      const remainder = consumeEcho(payload.worktreeId, payload.chunk);
      if (!remainder) {
        return;
      }
      const normalized = remainder.replace(/\r/g, '');
      const plain = stripAnsi(normalized);
      captureStatusLine(payload.worktreeId, plain);
      appendSummaryBuffer(payload.worktreeId, plain);
      if (!plain.trim()) {
        return;
      }
      const now = Date.now();
      setCodexActivity((prev) => ({ ...prev, [payload.worktreeId]: now }));
    });
    return unsubscribe;
  }, [api, appendSummaryBuffer, captureStatusLine, consumeEcho]);

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
        const message = error instanceof Error ? error.message : 'Failed to load application state';
        setNotification({ kind: 'error', message });
      }
    };

    bootstrap().catch((error) => {
      const message = error instanceof Error ? error.message : 'Failed to bootstrap renderer';
      setNotification({ kind: 'error', message });
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

  const runAction = useCallback(
    async <T,>(action: () => Promise<T>, options?: { useGlobalBusy?: boolean }): Promise<T | undefined> => {
      const useGlobalBusy = options?.useGlobalBusy ?? true;
      if (useGlobalBusy) {
        setBusy(true);
      }
      setNotification(null);
      try {
        return await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error';
        setNotification({ kind: 'error', message });
        console.error(error);
        return undefined;
      } finally {
        if (useGlobalBusy) {
          setBusy(false);
        }
      }
    },
    [setBusy, setNotification]
  );

  const handleToggleTheme = useCallback(async () => {
    const currentTheme = state.preferences.theme;
    const nextTheme: ThemePreference = currentTheme === 'dark' ? 'light' : 'dark';
    applyThemePreference(nextTheme);
    try {
      const updatedState = await api.setThemePreference(nextTheme);
      applyState(updatedState, selectedProjectId, selectedWorktreeId);
    } catch (error) {
      applyThemePreference(currentTheme);
      const message =
        error instanceof Error ? error.message : 'Failed to update theme preference';
      setNotification({ kind: 'error', message });
      console.error('[theme] failed to update preference', error);
    }
  }, [api, applyState, applyThemePreference, selectedProjectId, selectedWorktreeId, state.preferences.theme]);

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

  const handleRemoveProject = useCallback(
    async (projectId: string) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return;
      }

      const confirmed = window.confirm(
        `Remove ${project.name} from Staremaster? Worktrees remain on disk and can be re-added later.`
      );
      if (!confirmed) {
        return;
      }

      const associatedWorktrees = state.worktrees.filter((worktree) => worktree.projectId === projectId);
      const removedIds = new Set<string>(associatedWorktrees.map((worktree) => worktree.id));
      removedIds.add(`project-root:${projectId}`);

      const nextState = await runAction(() => api.removeProject(projectId));
      if (!nextState) {
        return;
      }

      removedIds.forEach((id) => {
        delete worktreeCacheRef.current[id];
        removeStoredPaneLayout(id);
      });

      setPaneLayouts((prev) => {
        let mutated = false;
        const next = { ...prev };
        removedIds.forEach((id) => {
          const layout = next[id];
          if (layout) {
            layout.panes.forEach((pane) => {
              bootstrappedPaneIdsRef.current.delete(pane.id);
            });
            delete next[id];
            mutated = true;
          }
        });
        return mutated ? next : prev;
      });

      setRenderedWorktreeIds((prev) => {
        const next = prev.filter((id) => !removedIds.has(id));
        return next.length === prev.length ? prev : next;
      });

      setHiddenProjectIds((prev) => prev.filter((id) => id !== projectId));
      setCollapsedProjectIds((prev) => prev.filter((id) => id !== projectId));

      applyState(nextState);
    },
    [api, applyState, runAction, state.projects, state.worktrees]
  );

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
      setNotification({ kind: 'error', message: 'Feature name is required' });
      return;
    }
    const targetProjectId = createProjectId ?? effectiveProject?.id ?? null;
    if (!targetProjectId) {
      setNotification({ kind: 'error', message: 'Select a project before creating a worktree' });
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
      setNotification({ kind: 'error', message: 'Cannot merge the main project worktree into itself.' });
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

  const handlePullWorktree = async (worktree: WorktreeDescriptor) => {
    if (worktree.id.startsWith('project-root:')) {
      setNotification({ kind: 'error', message: 'Pull is not available for the main project worktree.' });
      return;
    }
    const readiness = pullReadiness[worktree.id];
    if (!readiness?.clean) {
      const message = readiness?.message ?? 'Pull requires a clean worktree.';
      setNotification({ kind: 'error', message });
      return;
    }
    const nextState = await runAction(() => api.pullWorktree(worktree.id), { useGlobalBusy: false });
    if (nextState) {
      applyState(nextState, worktree.projectId, worktree.id);
      setNotification({
        kind: 'success',
        message: 'Pulled latest main branch changes into the worktree.'
      });
    }
  };

  const handleDeleteWorktree = async (worktree: WorktreeDescriptor) => {
    if (worktree.id.startsWith('project-root:')) {
      setNotification({ kind: 'error', message: 'The main project worktree cannot be deleted.' });
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
      const existingLayout = paneLayouts[worktree.id];
      if (existingLayout) {
        existingLayout.panes.forEach((pane) => {
          bootstrappedPaneIdsRef.current.delete(pane.id);
        });
      }
      setPaneLayouts((prev) => {
        if (!prev[worktree.id]) {
          return prev;
        }
        const next = { ...prev };
        delete next[worktree.id];
        return next;
      });
      removeStoredPaneLayout(worktree.id);
      setRenderedWorktreeIds((prev) => prev.filter((id) => id !== worktree.id));
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

  const handleWorktreeStatusChange = useCallback(
    (payload: { worktreeId: string; clean: boolean; message?: string }) => {
      setPullReadiness((prev) => {
        const nextEntry = { clean: payload.clean, message: payload.message };
        const existing = prev[payload.worktreeId];
        if (existing && existing.clean === nextEntry.clean && existing.message === nextEntry.message) {
          return prev;
        }
        return {
          ...prev,
          [payload.worktreeId]: nextEntry
        };
      });
    },
    [setPullReadiness]
  );

  const handlePaneNotification = useCallback(
    (message: string | null) => {
      if (!message) {
        setNotification(null);
        return;
      }
      setNotification({ kind: 'error', message });
    },
    [setNotification]
  );

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

  const renderOrchestratorPane = useCallback(
    ({
      pane,
      worktree,
      isActive,
      isVisible
    }: { pane: PaneInstance; worktree: WorktreeDescriptor; isActive: boolean; isVisible: boolean }) => {
      const orchestratorWorktreeId = resolveSessionWorktreeId(worktree.id) ?? worktree.id;
      return (
        <div
          key={pane.id}
          id={`pane-panel-${pane.id}`}
          className="codex-pane-wrapper"
          role="tabpanel"
          aria-labelledby={`pane-tab-${pane.id}`}
          aria-hidden={!isVisible}
          style={{ display: isVisible ? 'flex' : 'none' }}
        >
          <OrchestratorPane
            worktreeId={orchestratorWorktreeId}
            active={isActive}
            visible={isVisible}
            paneId={pane.id}
            onBootstrapped={() => markPaneBootstrapped(worktree.id, pane.id)}
            onUnbootstrapped={() => markPaneUnbootstrapped(worktree.id, pane.id)}
          />
        </div>
      );
    },
    [markPaneBootstrapped, markPaneUnbootstrapped, resolveSessionWorktreeId]
  );

  const renderCodexPane = useCallback(
    ({
      pane,
      worktree,
      session,
      isActive,
      isVisible
    }: {
      pane: PaneInstance;
      worktree: WorktreeDescriptor;
      session: DerivedCodexSession | undefined;
      isActive: boolean;
      isVisible: boolean;
    }) => {
      const sessionWorktreeId = resolveSessionWorktreeId(worktree.id);
      const effectiveSession = sessionWorktreeId
        ? codexSessions.get(sessionWorktreeId) ?? session
        : session;

      return (
        <div
          key={pane.id}
          id={`pane-panel-${pane.id}`}
          className="codex-pane-wrapper"
          role="tabpanel"
          aria-labelledby={`pane-tab-${pane.id}`}
          aria-hidden={!isVisible}
          style={{ display: isVisible ? 'flex' : 'none' }}
        >
          {isTerminalCodex ? (
            <CodexTerminalShellPane
              api={api}
              worktree={worktree}
              session={effectiveSession}
              active={isActive}
              visible={isVisible}
              paneId={pane.id}
              sessionWorktreeId={sessionWorktreeId}
              onNotification={handlePaneNotification}
              onUserInput={(data) => {
                if (sessionWorktreeId) {
                  handleCodexUserInput(sessionWorktreeId, data);
                }
              }}
              onBootstrapped={() => markPaneBootstrapped(worktree.id, pane.id)}
              onUnbootstrapped={() => markPaneUnbootstrapped(worktree.id, pane.id)}
              initialScrollState={codexScrollStateRef.current[`${worktree.id}:${pane.id}`]}
              onScrollStateChange={(worktreeId, state) => {
                codexScrollStateRef.current[`${worktreeId}:${pane.id}`] = state;
              }}
              theme={state.preferences.theme}
            />
          ) : (
            <CodexPane
              api={api}
              bridge={bridge}
              worktree={worktree}
              session={effectiveSession}
              active={isActive}
              visible={isVisible}
              paneId={pane.id}
              sessionWorktreeId={sessionWorktreeId}
              onNotification={handlePaneNotification}
              onUserInput={(data) => {
                if (sessionWorktreeId) {
                  handleCodexUserInput(sessionWorktreeId, data);
                }
              }}
              onBootstrapped={() => markPaneBootstrapped(worktree.id, pane.id)}
              onUnbootstrapped={() => markPaneUnbootstrapped(worktree.id, pane.id)}
              initialScrollState={codexScrollStateRef.current[`${worktree.id}:${pane.id}`]}
              onScrollStateChange={(worktreeId, state) => {
                codexScrollStateRef.current[`${worktreeId}:${pane.id}`] = state;
              }}
              theme={state.preferences.theme}
            />
          )}
        </div>
      );
    },
    [
      api,
      bridge,
      handleCodexUserInput,
      isTerminalCodex,
      markPaneBootstrapped,
      markPaneUnbootstrapped,
      codexSessions,
      resolveSessionWorktreeId,
      handlePaneNotification,
      state.preferences.theme
    ]
  );

  const renderTerminalPane = useCallback(
    ({
      pane,
      worktree,
      isActive,
      isVisible
    }: { pane: PaneInstance; worktree: WorktreeDescriptor; isActive: boolean; isVisible: boolean }) => (
      <div
        key={pane.id}
        id={`pane-panel-${pane.id}`}
        className="codex-pane-wrapper"
        role="tabpanel"
        aria-labelledby={`pane-tab-${pane.id}`}
        aria-hidden={!isVisible}
        style={{ display: isVisible ? 'flex' : 'none' }}
      >
        <WorktreeTerminalPane
          api={api}
          worktree={worktree}
          active={isActive}
          visible={isVisible}
          paneId={pane.id}
          onNotification={handlePaneNotification}
          onBootstrapped={() => markPaneBootstrapped(worktree.id, pane.id)}
          initialScrollState={terminalScrollStateRef.current[`${worktree.id}:${pane.id}`]}
          onScrollStateChange={(worktreeId, state) => {
            terminalScrollStateRef.current[`${worktreeId}:${pane.id}`] = state;
          }}
          theme={state.preferences.theme}
        />
      </div>
    ),
    [api, handlePaneNotification, markPaneBootstrapped, state.preferences.theme]
  );

  busyStatesRef.current = busyStates;
  const busySignature = busySignatureParts.sort().join('|');

  useEffect(() => {
    const tracker = longRunTrackerRef.current;
    const timestamp = Date.now();
    const snapshot = busyStatesRef.current;
    const validIds = new Set<string>();
    const idleIds: string[] = [];

    snapshot.forEach(({ id, busy, running }) => {
      validIds.add(id);
      const effectiveBusy = busy || running;
      if (!effectiveBusy) {
        idleIds.push(id);
      }
      if (!tracker.update(id, effectiveBusy, timestamp)) {
        return;
      }
      void notifyLongRunCompletion(id);
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
          delete codexStatusHeartbeatRef.current[id];
        }
      });
      Object.keys(next).forEach((key) => {
        if (!validIds.has(key)) {
          delete next[key];
          changed = true;
          delete codexStatusHeartbeatRef.current[key];
        }
      });
      return changed ? next : prev;
    });

    tracker.prune(validIds);
  }, [busySignature, notifyLongRunCompletion, setCodexStatusLines, state.projects, state.worktrees]);

  if (state.projects.length === 0) {
    return (
      <main className="empty-state">
        <div className="empty-card">
          <h1>Staremaster</h1>
          <p>Add a git repository to start coordinating worktrees and Codex sessions.</p>
          <button type="button" onClick={handleAddProject} disabled={busy || !bridge}>
            Add Project
          </button>
          {notification ? (
            <p className={`banner banner-${notification.kind}`}>{notification.message}</p>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <OrchestratorProvider api={api} activeWorktreeIds={orchestratorWorktreeIds}>
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
            <button type="button" onClick={handleToggleTheme} disabled={!bridge}>
              {state.preferences.theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
            </button>
            <button type="button" onClick={() => setShowDebugPanel((v) => !v)} disabled={!bridge}>
              {showDebugPanel ? 'Hide debug' : 'Debug'}
            </button>
          </div>
          <div className="project-list">
            {showDebugPanel ? (
              <section className="project-section project-section--debug" aria-label="Debug: Codex resume state">
                <header className="project-section__header">
                  <div className="project-section__title-group">
                    <span className="project-section__title">Codex Debug</span>
                  </div>
                </header>
                <div className="project-worktree-list" role="region" aria-label="Codex debug listing">
                  {state.projects.map((project) => {
                    const rootId = `project-root:${project.id}`;
                    const worktrees = state.worktrees.filter((w) => w.projectId === project.id);
                    const defaultSession = project.defaultWorktreeId
                      ? codexSessions.get(project.defaultWorktreeId)
                      : undefined;
                    return (
                      <div
                        key={project.id}
                        style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border-subtle)' }}
                      >
                        <div>
                          <strong>{project.name}</strong>
                          <span style={{ marginLeft: 8, opacity: 0.8 }}>root</span>
                        </div>
                        <div style={{ fontSize: '0.85em', opacity: 0.9 }}>
                          resume: {formatResumeCommand(defaultSession?.codexSessionId)}
                        </div>
                        <div style={{ marginTop: 4 }}>
                          {worktrees.map((w) => {
                            const session = codexSessions.get(w.id);
                            return (
                              <div key={w.id} style={{ marginBottom: 4 }}>
                                <div>
                                  <code>{w.featureName}</code>
                                  <span style={{ marginLeft: 8, opacity: 0.8 }}>{w.branch}</span>
                                </div>
                                <div style={{ fontSize: '0.85em', opacity: 0.9 }}>
                                  sessionId: {session?.codexSessionId ?? '—'} · resume: {formatResumeCommand(session?.codexSessionId)}
                                </div>
                              </div>
                            );
                          })}
                          <div style={{ fontSize: '0.85em', opacity: 0.9, marginTop: 6 }}>
                            alias {rootId}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}
            {visibleProjects.map((project) => {
              const worktrees = filteredWorktrees
                .filter((worktree) => worktree.projectId === project.id)
                .sort((a, b) => a.featureName.localeCompare(b.featureName));
              const isCollapsed = collapsedProjects.has(project.id);
              const isActiveProject = worktrees.some((worktree) => worktree.id === selectedWorktreeId);
              const rootWorktreeId = `project-root:${project.id}`;
              const rootDescriptor = projectRootDescriptors.get(project.id);
              const projectBranch = rootDescriptor?.branch ?? 'main';
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
                        onClick={() => void handleRemoveProject(project.id)}
                        disabled={busy || !bridge}
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
                          const lastStatusHeartbeat = codexStatusHeartbeatRef.current[entry.id] ?? 0;
                          const isWorking = lastStatusHeartbeat > 0 && busyTimestamp - lastStatusHeartbeat < CODEX_STATUS_IDLE_WINDOW_MS;
                          const tabStatusLine = codexStatusLines[entry.id] ?? null;
                          registerBusyState(entry.id, isBusy, isWorking);
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
                              <span className="project-worktree__info">
                                <span className="project-worktree__primary">
                                  <span className="project-worktree__name">main</span>
                                  <span className="project-worktree__branch">{projectBranch}</span>
                                </span>
                                {tabStatusLine ? (
                                  <span className="project-worktree__status-text" title={tabStatusLine}>
                                    {tabStatusLine}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                          );
                        }

                        const worktree = entry.worktree;
                        const isActive = worktree.id === selectedWorktreeId;
                        const session = codexSessions.get(worktree.id);
                        const lastActivity = codexActivity[worktree.id];
                        const lastUserInput = codexLastInputRef.current[worktree.id] ?? 0;
                        const allowSpinner = (session ? isInteractiveStatus(session.status) : false) || isTerminalCodex;
                        const isCodexBusy = computeBusyFlag({
                          allowSpinner,
                          lastActivity,
                          lastInput: lastUserInput,
                          now: busyTimestamp
                        });
                        const lastStatusHeartbeat = codexStatusHeartbeatRef.current[worktree.id] ?? 0;
                        const isWorking = lastStatusHeartbeat > 0 && busyTimestamp - lastStatusHeartbeat < CODEX_STATUS_IDLE_WINDOW_MS;
                        const tabStatusLine = codexStatusLines[worktree.id] ?? null;
                        registerBusyState(worktree.id, isCodexBusy, isWorking);
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
                            <span className="project-worktree__info">
                              <span className="project-worktree__primary">
                                <span className="project-worktree__name">{worktree.featureName}</span>
                                <span className="project-worktree__branch">{worktree.branch}</span>
                              </span>
                              {tabStatusLine ? (
                                <span className="project-worktree__status-text" title={tabStatusLine}>
                                  {tabStatusLine}
                                </span>
                              ) : null}
                            </span>
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
          {notification ? (
            <div className={`banner banner-${notification.kind}`}>{notification.message}</div>
          ) : null}
          {selectedWorktree ? (
            <div className="worktree-overview">
              <header className="overview-header">
                <div>
                  <h1>{selectedWorktreeTitle}</h1>
                  <p>
                    Branch <code>{selectedWorktree.branch}</code>
                    {' · Path '}
                    <code title={selectedWorktree.path}>{selectedWorktree.path}</code>
                  </p>
                  {worktreeStatusLabel ? (
                    <div className={`worktree-status worktree-status--${selectedWorktree.status}`}>
                      {worktreeStatusLabel}
                    </div>
                  ) : null}
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
                    onClick={() => handlePullWorktree(selectedWorktree)}
                    disabled={pullButtonDisabled}
                    title={pullButtonTitle}
                  >
                    {isPulling ? 'Pulling…' : 'Pull'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMergeWorktree(selectedWorktree)}
                    disabled={mergeButtonDisabled}
                    title={mergeButtonTitle}
                  >
                    Merge
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteWorktree(selectedWorktree)}
                    disabled={busy || !bridge || isRootSelection || isPulling || isMerging}
                  >
                    Delete
                  </button>
                </div>
                {pullHelperText && !selectedPullInfo?.clean ? (
                  <p className="worktree-hint" role="status">
                    {pullHelperText}
                  </p>
                ) : null}
              </header>
              <ResizableColumns
                left={
                  <div className="worktree-pane-host">
                    {visitedWorktreeIds.map((worktreeId) => {
                      const descriptor = resolveWorktreeDescriptor(worktreeId);
                      if (!descriptor) {
                        return null;
                      }
                      const layout =
                        paneLayouts[worktreeId] ?? readStoredPaneLayout(worktreeId) ?? createDefaultPaneLayout(worktreeId);
                      const { panes, activePaneId, showAll } = layout;
                      const isSelectedWorktree = selectedWorktree?.id === worktreeId;
                      const isMenuOpen = isSelectedWorktree && openPaneMenuFor === worktreeId;
                      const paneElements = panes.map((pane) => {
                        const isActivePane = activePaneId === pane.id;
                        const isPaneVisible = isSelectedWorktree && (showAll || isActivePane);
                        switch (pane.kind) {
                          case 'codex':
                            return renderCodexPane({
                              pane,
                              worktree: descriptor,
                              session: codexSessions.get(descriptor.id),
                              isActive: isSelectedWorktree && isActivePane,
                              isVisible: isPaneVisible,
                              paneId: pane.id
                            });
                          case 'terminal':
                            return renderTerminalPane({
                              pane,
                              worktree: descriptor,
                              isActive: isSelectedWorktree && isActivePane,
                              isVisible: isPaneVisible
                            });
                          case 'orchestrator':
                            return renderOrchestratorPane({
                              pane,
                              worktree: descriptor,
                              isActive: isSelectedWorktree && isActivePane,
                              isVisible: isPaneVisible
                            });
                          default:
                            return null;
                        }
                      });
                      return (
                        <div
                          key={worktreeId}
                          className="worktree-panes"
                          style={{ display: isSelectedWorktree ? 'flex' : 'none' }}
                        >
                          <div className="pane-strip">
                            <div className="pane-strip__tabs" role="tablist" aria-label="Worktree panes">
                              {panes.map((pane) => {
                                const isActivePane = activePaneId === pane.id;
                                const tabSelected = showAll || isActivePane;
                                const tabId = `pane-tab-${pane.id}`;
                                return (
                                  <div
                                    key={pane.id}
                                    className={`pane-strip__tab${tabSelected ? ' pane-strip__tab--active' : ''}`}
                                  >
                                    <button
                                      type="button"
                                      id={tabId}
                                      role="tab"
                                      aria-selected={tabSelected}
                                      aria-controls={`pane-panel-${pane.id}`}
                                      className="pane-strip__tab-trigger"
                                      onClick={() => handleActivatePane(worktreeId, pane.id)}
                                    >
                                      {pane.title}
                                    </button>
                                    {panes.length > 1 ? (
                                      <button
                                        type="button"
                                        className="pane-strip__tab-close"
                                        aria-label={`Close ${pane.title} pane`}
                                        onClick={() => handleRemovePane(worktreeId, pane)}
                                      >
                                        ×
                                      </button>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                            <div className="pane-strip__actions">
                              <label className="pane-strip__toggle">
                                <input
                                  type="checkbox"
                                  checked={showAll}
                                  onChange={() => handleToggleShowAll(worktreeId)}
                                  disabled={panes.length <= 1}
                                />
                                Show all
                              </label>
                              <div className={`pane-strip__add${isMenuOpen ? ' pane-strip__add--open' : ''}`}>
                                <button
                                  type="button"
                                  aria-haspopup="menu"
                                  aria-expanded={isMenuOpen}
                                  aria-label="Add pane"
                                  onClick={() => handlePaneMenuToggle(worktreeId)}
                                  disabled={!isSelectedWorktree}
                                >
                                  +
                                </button>
                                {isMenuOpen ? (
                                  <div className="pane-strip__menu" role="menu">
                                    <button type="button" role="menuitem" onClick={() => handleAddPane(worktreeId, 'codex')}>
                                      New Codex
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => handleAddPane(worktreeId, 'terminal')}
                                    >
                                      New Terminal
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => handleAddPane(worktreeId, 'orchestrator')}
                                    >
                                      New Orchestrator
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </div>
                          <div className="pane-strip__panes">{paneElements}</div>
                        </div>
                      );
                    })}
                  </div>
                }
                right={
                  <section className="diff-pane">
                    <GitPanel
                      api={api}
                      worktree={selectedWorktree}
                      onStatusChange={handleWorktreeStatusChange}
                    />
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
    </OrchestratorProvider>
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
    pullWorktree: async (_worktreeId?: string) => {
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
    summarizeCodexOutput: async (worktreeId: string, text: string) => {
      void worktreeId;
      void text;
      throw new Error('Renderer API unavailable: summarizeCodexOutput');
    },
    refreshCodexSessionId: async (worktreeId: string, sessionId?: string | null) => {
      void worktreeId;
      void sessionId;
      return null;
    },
    listCodexSessions: async (worktreeId: string) => {
      void worktreeId;
      return [];
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
    getTerminalSnapshot: async () => ({ content: '', lastEventId: 0 }),
    getTerminalDelta: async () => ({ chunks: [], lastEventId: 0 }),
    onTerminalOutput: () => noop,
    onTerminalExit: () => noop,
    setThemePreference: async (theme) => {
      void theme;
      return state;
    },
    getOrchestratorSnapshot: async () => null,
    startOrchestratorRun: async (worktreeId: string, input: OrchestratorBriefingInput) => {
      void worktreeId;
      void input;
      throw new Error('Renderer API unavailable: startOrchestratorRun');
    },
    submitOrchestratorFollowUp: async (worktreeId: string, input: OrchestratorFollowUpInput) => {
      void worktreeId;
      void input;
      throw new Error('Renderer API unavailable: submitOrchestratorFollowUp');
    },
    approveOrchestratorTask: async (worktreeId: string, taskId: string, approver: string) => {
      void worktreeId;
      void taskId;
      void approver;
    },
    commentOnOrchestratorTask: async (worktreeId: string, input: OrchestratorCommentInput) => {
      void worktreeId;
      void input;
    },
    onOrchestratorEvent: () => noop
  };
};
