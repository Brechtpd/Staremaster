import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type { RendererApi } from '@shared/api';
import type { AgentGraphNodeState } from '@shared/orchestrator';
import { AGENT_GRAPH_EDGES, AGENT_GRAPH_ROLES } from '@shared/orchestrator-graph';
import type {
  ConversationEntry,
  OrchestratorBriefingInput,
  OrchestratorCommentInput,
  OrchestratorEvent,
  OrchestratorFollowUpInput,
  OrchestratorRunSummary,
  OrchestratorSnapshot,
  TaskRecord,
  WorkerRole,
  WorkerStatus
} from '@shared/orchestrator';
import type { WorkerSpawnConfig } from '@shared/orchestrator-config';

interface OrchestratorWorktreeState {
  run: OrchestratorRunSummary | null;
  tasks: TaskRecord[];
  workers: WorkerStatus[];
  conversations: ConversationEntry[];
  workerLogs: Record<string, string>;
  activity: Array<{
    id: string;
    occurredAt: string;
    kind: string;
    message: string;
  }>;
  ready: boolean;
  lastEventAt?: string;
  error?: string;
  metadata?: {
    implementerLockHeldBy: string | null;
    workerCounts?: Partial<Record<WorkerRole, number>>;
    modelPriority?: Partial<Record<WorkerRole, string[]>>;
    agentStates?: Partial<Record<WorkerRole, AgentGraphNodeState>>;
  };
}

interface PersistedRun {
  run: OrchestratorRunSummary;
  updatedAt: string;
}

interface OrchestratorState {
  worktrees: Record<string, OrchestratorWorktreeState>;
  persistedRuns: Record<string, PersistedRun>;
}

type HydrateAction = {
  type: 'hydrate';
  worktreeId: string;
  snapshot: OrchestratorSnapshot | null;
  error?: string;
};

type EventAction = {
  type: 'event';
  event: OrchestratorEvent;
};

type PruneAction = {
  type: 'prune';
  activeWorktreeIds: Set<string>;
};

type SetRunAction = {
  type: 'set-run';
  worktreeId: string;
  run: OrchestratorRunSummary;
};

type Action = HydrateAction | EventAction | PruneAction | SetRunAction;

const localStorageKey = 'orchestrator/runs';

const DEFAULT_WORKTREE_STATE: OrchestratorWorktreeState = {
  run: null,
  tasks: [],
  workers: [],
  conversations: [],
  workerLogs: {},
  activity: [],
  ready: false
};

const createFallbackRun = (worktreeId: string): OrchestratorRunSummary => {
  const now = new Date().toISOString();
  return {
    worktreeId,
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    epicId: null,
    status: 'running',
    description: 'Orchestrator run (stub)',
    createdAt: now,
    updatedAt: now
  };
};

const cloneMetadata = (
  metadata?: OrchestratorWorktreeState['metadata']
): OrchestratorWorktreeState['metadata'] | undefined => {
  if (!metadata) {
    return undefined;
  }
  const next: OrchestratorWorktreeState['metadata'] = {
    implementerLockHeldBy: metadata.implementerLockHeldBy ?? null
  };
  if (metadata.workerCounts) {
    next.workerCounts = { ...metadata.workerCounts };
  }
  if (metadata.modelPriority) {
    const priority: Partial<Record<WorkerRole, string[]>> = {};
    for (const [role, models] of Object.entries(metadata.modelPriority) as Array<[WorkerRole, string[]]>) {
      priority[role] = models.slice();
    }
    next.modelPriority = priority;
  }
  return next;
};

const ensureMetadata = (
  metadata?: OrchestratorWorktreeState['metadata']
): OrchestratorWorktreeState['metadata'] => {
  const next = cloneMetadata(metadata) ?? { implementerLockHeldBy: null };
  if (!next.workerCounts) {
    next.workerCounts = {};
  }
  if (!next.modelPriority) {
    next.modelPriority = {};
  }
  return next;
};

const pushActivity = (
  existing: Array<{ id: string; occurredAt: string; kind: string; message: string }>,
  entry: { kind: string; message: string }
) => {
  const now = new Date().toISOString();
  const next = [...existing, { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, occurredAt: now, ...entry }];
  return next.slice(-200);
};

const cloneState = (value: OrchestratorWorktreeState): OrchestratorWorktreeState => ({
  ...value,
  tasks: value.tasks.slice(),
  workers: value.workers.slice(),
  conversations: value.conversations.slice(),
  workerLogs: { ...value.workerLogs },
  activity: value.activity.slice(),
  metadata: cloneMetadata(value.metadata)
});

const ensureState = (
  collection: Record<string, OrchestratorWorktreeState>,
  worktreeId: string
): OrchestratorWorktreeState => {
  const existing = collection[worktreeId];
  if (existing) {
    return existing;
  }
  return { ...DEFAULT_WORKTREE_STATE, tasks: [], workers: [], conversations: [] };
};

const loadPersistedRuns = (): Record<string, PersistedRun> => {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(localStorageKey);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const result: Record<string, PersistedRun> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const run = (value as { run?: unknown }).run;
      const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
      if (run && typeof updatedAt === 'string') {
        result[key] = { run: run as OrchestratorRunSummary, updatedAt };
      }
    }
    return result;
  } catch (error) {
    console.warn('[orchestrator] failed to load persisted runs', error);
    return {};
  }
};

const reducer = (state: OrchestratorState, action: Action): OrchestratorState => {
  switch (action.type) {
    case 'hydrate': {
      const nextWorktrees = { ...state.worktrees };
      const base = cloneState(ensureState(nextWorktrees, action.worktreeId));
      base.ready = true;
      base.error = action.error;
      if (action.snapshot) {
        base.run = action.snapshot.run;
        base.tasks = action.snapshot.tasks.slice();
        base.workers = action.snapshot.workers.slice();
        base.lastEventAt = action.snapshot.lastEventAt;
        base.error = undefined;
        base.metadata = ensureMetadata(action.snapshot.metadata);
        base.activity = pushActivity(base.activity, {
          kind: 'snapshot',
          message: `Snapshot received (${action.snapshot.run.status})`
        });
      }
      if (!action.snapshot) {
        base.run = null;
        base.tasks = [];
        base.workers = [];
        base.workerLogs = {};
        base.activity = pushActivity(base.activity, {
          kind: 'snapshot',
          message: 'Run cleared'
        });
        base.lastEventAt = undefined;
        base.metadata = ensureMetadata();
      }
      nextWorktrees[action.worktreeId] = base;
      let nextPersisted = state.persistedRuns;
      if (action.snapshot) {
        nextPersisted = { ...state.persistedRuns, [action.worktreeId]: { run: action.snapshot.run, updatedAt: action.snapshot.run.updatedAt } };
      } else if (state.persistedRuns[action.worktreeId]) {
        const updated = { ...state.persistedRuns };
        delete updated[action.worktreeId];
        nextPersisted = updated;
      }
      return {
        worktrees: nextWorktrees,
        persistedRuns: nextPersisted
      };
    }
    case 'event': {
      const { event } = action;
      const worktreeId = event.worktreeId;
      const current = cloneState(ensureState(state.worktrees, worktreeId));
      let mutated = false;
      switch (event.kind) {
        case 'snapshot': {
          current.ready = true;
          if (event.snapshot) {
            current.run = event.snapshot.run;
            current.tasks = event.snapshot.tasks.slice();
            current.workers = event.snapshot.workers.slice();
            current.lastEventAt = event.snapshot.lastEventAt;
            current.error = undefined;
            current.metadata = ensureMetadata(event.snapshot.metadata);
            current.activity = pushActivity(current.activity, {
              kind: 'snapshot',
              message: `Snapshot updated (${event.snapshot.run.status})`
            });
          } else {
            current.run = null;
            current.tasks = [];
            current.workers = [];
            current.workerLogs = {};
            current.lastEventAt = new Date().toISOString();
            current.metadata = ensureMetadata();
            current.activity = pushActivity(current.activity, {
              kind: 'stop',
              message: 'Run stopped'
            });
          }
          mutated = true;
          break;
        }
        case 'run-status': {
          current.ready = true;
          current.run = event.run;
          current.lastEventAt = event.run.updatedAt;
          current.error = undefined;
           current.activity = pushActivity(current.activity, {
             kind: 'run-status',
             message: `Run status → ${event.run.status}`
           });
          mutated = true;
          break;
        }
        case 'tasks-updated': {
          current.tasks = event.tasks.slice();
          current.lastEventAt = new Date().toISOString();
          current.activity = pushActivity(current.activity, {
            kind: 'tasks',
            message: `Tasks updated (${event.tasks.length})`
          });
          mutated = true;
          break;
        }
        case 'tasks-removed': {
          if (current.tasks.length > 0) {
            const set = new Set(event.taskIds);
            const filtered = current.tasks.filter((task) => !set.has(task.id));
            if (filtered.length !== current.tasks.length) {
              current.tasks = filtered;
              current.lastEventAt = new Date().toISOString();
              current.activity = pushActivity(current.activity, {
                kind: 'tasks',
                message: `Removed ${event.taskIds.length} task(s)`
              });
              mutated = true;
            }
          }
          break;
        }
        case 'workers-updated': {
          const map = new Map(current.workers.map((worker) => [worker.id, worker]));
          const messages: string[] = [];
          for (const worker of event.workers) {
            map.set(worker.id, worker);
            if (worker.logTail) {
              current.workerLogs[worker.id] = worker.logTail;
            }
            const taskMessage = worker.taskId ? ` (${worker.taskId})` : '';
            messages.push(`${worker.id} → ${worker.state}${taskMessage}`);
          }
          current.workers = Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
          current.lastEventAt = new Date().toISOString();
          const implementerUpdate = event.workers.find((worker) => worker.role === 'implementer');
          if (!current.metadata) {
            current.metadata = { implementerLockHeldBy: null };
          }
          if (implementerUpdate) {
            current.metadata.implementerLockHeldBy =
              implementerUpdate.state === 'working' ? implementerUpdate.id : null;
          }
          if (messages.length > 0) {
            current.activity = pushActivity(current.activity, {
              kind: 'workers',
              message: messages.join(', ')
            });
          }
          mutated = true;
          break;
        }
        case 'worker-log': {
          const existingLog = current.workerLogs[event.workerId] ?? '';
          const appended = (existingLog + event.chunk).slice(-4000);
          current.workerLogs = { ...current.workerLogs, [event.workerId]: appended };
          current.lastEventAt = event.timestamp;
          current.activity = pushActivity(current.activity, {
            kind: 'worker-log',
            message: `${event.workerId}: ${event.chunk.trim().slice(0, 120)}`
          });
          mutated = true;
          break;
        }
        case 'conversation-appended': {
          current.conversations = [...current.conversations, event.entry].slice(-200);
          current.lastEventAt = event.entry.createdAt;
          current.activity = pushActivity(current.activity, {
            kind: 'conversation',
            message: `${event.entry.author} on ${event.entry.taskId}`
          });
          mutated = true;
          break;
        }
        case 'error': {
          current.error = event.message;
          current.lastEventAt = event.occurredAt;
          current.activity = pushActivity(current.activity, {
            kind: 'error',
            message: event.message
          });
          mutated = true;
          break;
        }
        default:
          break;
      }
      if (!mutated) {
        return state;
      }
      const nextWorktrees = { ...state.worktrees, [worktreeId]: current };
      let nextPersisted = state.persistedRuns;
      if (current.run) {
        nextPersisted = { ...state.persistedRuns, [worktreeId]: { run: current.run, updatedAt: current.run.updatedAt } };
      } else if (state.persistedRuns[worktreeId]) {
        const updated = { ...state.persistedRuns };
        delete updated[worktreeId];
        nextPersisted = updated;
      }
      return {
        worktrees: nextWorktrees,
        persistedRuns: nextPersisted
      };
    }
    case 'set-run': {
      const current = cloneState(ensureState(state.worktrees, action.worktreeId));
      current.run = action.run;
      current.ready = true;
      current.error = undefined;
      current.lastEventAt = action.run.updatedAt;
      current.workerLogs = { ...current.workerLogs };
      const nextWorktrees = { ...state.worktrees, [action.worktreeId]: current };
      const nextPersisted = { ...state.persistedRuns, [action.worktreeId]: { run: action.run, updatedAt: action.run.updatedAt } };
      return {
        worktrees: nextWorktrees,
        persistedRuns: nextPersisted
      };
    }
    case 'prune': {
      const nextWorktrees: Record<string, OrchestratorWorktreeState> = {};
      const nextPersisted: Record<string, PersistedRun> = {};
      for (const [key, value] of Object.entries(state.worktrees)) {
        if (action.activeWorktreeIds.has(key)) {
          nextWorktrees[key] = value;
        }
      }
      for (const [key, value] of Object.entries(state.persistedRuns)) {
        if (action.activeWorktreeIds.has(key)) {
          nextPersisted[key] = value;
        }
      }
      if (Object.keys(nextWorktrees).length === Object.keys(state.worktrees).length) {
        return state;
      }
      return {
        worktrees: nextWorktrees,
        persistedRuns: nextPersisted
      };
    }
    default:
      return state;
  }
};

interface OrchestratorContextValue {
  state: OrchestratorState;
  ensureWorktree: (worktreeId: string) => void;
  startRun: (worktreeId: string, input: OrchestratorBriefingInput) => Promise<OrchestratorRunSummary>;
  submitFollowUp: (worktreeId: string, input: OrchestratorFollowUpInput) => Promise<OrchestratorRunSummary>;
  approveTask: (worktreeId: string, taskId: string, approver: string) => Promise<void>;
  commentOnTask: (worktreeId: string, input: OrchestratorCommentInput) => Promise<void>;
  startWorkers: (worktreeId: string, configs?: WorkerSpawnConfig[]) => Promise<void>;
  stopWorkers: (worktreeId: string, roles?: WorkerRole[]) => Promise<void>;
  configureWorkers: (worktreeId: string, configs: WorkerSpawnConfig[]) => Promise<void>;
  stopRun: (worktreeId: string) => Promise<void>;
  openPath: (worktreeId: string, relativePath: string) => Promise<void>;
}

const OrchestratorContext = createContext<OrchestratorContextValue | null>(null);

const createInitialState = (): OrchestratorState => {
  const persisted = loadPersistedRuns();
  const worktrees: Record<string, OrchestratorWorktreeState> = {};
  for (const [worktreeId, record] of Object.entries(persisted)) {
    worktrees[worktreeId] = {
      ...DEFAULT_WORKTREE_STATE,
      run: record.run,
      ready: false,
      lastEventAt: record.updatedAt
    };
  }
  return {
    worktrees,
    persistedRuns: persisted
  };
};

interface OrchestratorProviderProps {
  api: RendererApi;
  activeWorktreeIds: string[];
  children: React.ReactNode;
}

export const OrchestratorProvider: React.FC<OrchestratorProviderProps> = ({ api, activeWorktreeIds, children }) => {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  const inflightRef = useRef(new Set<string>());
  const worktreesRef = useRef(state.worktrees);

  useEffect(() => {
    worktreesRef.current = state.worktrees;
  }, [state.worktrees]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const serialized = JSON.stringify(state.persistedRuns);
      window.localStorage.setItem(localStorageKey, serialized);
    } catch (error) {
      console.warn('[orchestrator] failed to persist runs', error);
    }
  }, [state.persistedRuns]);

  useEffect(() => {
    const unsubscribe = api.onOrchestratorEvent
      ? api.onOrchestratorEvent((event) => {
          dispatch({ type: 'event', event });
        })
      : () => {};
    return () => {
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    dispatch({ type: 'prune', activeWorktreeIds: new Set(activeWorktreeIds) });
  }, [activeWorktreeIds]);

  const ensureWorktree = useCallback(
    (worktreeId: string) => {
      if (!worktreeId) {
        return;
      }
      if (inflightRef.current.has(worktreeId)) {
        return;
      }
      const existing = worktreesRef.current[worktreeId];
      if (existing?.ready) {
        return;
      }
      inflightRef.current.add(worktreeId);
      if (!api.getOrchestratorSnapshot) {
        dispatch({ type: 'hydrate', worktreeId, snapshot: null });
        inflightRef.current.delete(worktreeId);
        return;
      }
      void api
        .getOrchestratorSnapshot(worktreeId)
        .then((snapshot) => {
          dispatch({ type: 'hydrate', worktreeId, snapshot: snapshot ?? null });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          dispatch({ type: 'hydrate', worktreeId, snapshot: null, error: message });
        })
        .finally(() => {
          inflightRef.current.delete(worktreeId);
        });
    },
    [api]
  );

  const startRun = useCallback(
    async (worktreeId: string, input: OrchestratorBriefingInput) => {
      if (!api.startOrchestratorRun) {
        const run = createFallbackRun(worktreeId);
        dispatch({ type: 'set-run', worktreeId, run });
        return run;
      }
      const run = await api.startOrchestratorRun(worktreeId, input);
      dispatch({ type: 'set-run', worktreeId, run });
      return run;
    },
    [api]
  );

  const submitFollowUp = useCallback(
    async (worktreeId: string, input: OrchestratorFollowUpInput) => {
      if (!api.submitOrchestratorFollowUp) {
        const run = createFallbackRun(worktreeId);
        dispatch({ type: 'set-run', worktreeId, run });
        return run;
      }
      const run = await api.submitOrchestratorFollowUp(worktreeId, input);
      dispatch({ type: 'set-run', worktreeId, run });
      return run;
    },
    [api]
  );

  const approveTask = useCallback(
    async (worktreeId: string, taskId: string, approver: string) => {
      if (!api.approveOrchestratorTask) {
        return;
      }
      await api.approveOrchestratorTask(worktreeId, taskId, approver);
    },
    [api]
  );

  const commentOnTask = useCallback(
    async (worktreeId: string, input: OrchestratorCommentInput) => {
      if (!api.commentOnOrchestratorTask) {
        return;
      }
      await api.commentOnOrchestratorTask(worktreeId, input);
    },
    [api]
  );

  const startWorkers = useCallback(
    async (worktreeId: string, configs?: WorkerSpawnConfig[]) => {
      if (!api.startOrchestratorWorkers) {
        return;
      }
      await api.startOrchestratorWorkers(worktreeId, configs);
    },
    [api]
  );

  const stopWorkers = useCallback(
    async (worktreeId: string, roles?: WorkerRole[]) => {
      if (!api.stopOrchestratorWorkers) {
        return;
      }
      await api.stopOrchestratorWorkers(worktreeId, roles);
    },
    [api]
  );

  const configureWorkers = useCallback(
    async (worktreeId: string, configs: WorkerSpawnConfig[]) => {
      if (!api.configureOrchestratorWorkers) {
        return;
      }
      await api.configureOrchestratorWorkers(worktreeId, configs);
    },
    [api]
  );

  const stopRun = useCallback(
    async (worktreeId: string) => {
      if (!api.stopOrchestratorRun) {
        dispatch({ type: 'hydrate', worktreeId, snapshot: null });
        return;
      }
      await api.stopOrchestratorRun(worktreeId);
      dispatch({ type: 'hydrate', worktreeId, snapshot: null });
    },
    [api]
  );

  const openPath = useCallback(
    async (worktreeId: string, relativePath: string) => {
      if (!api.openOrchestratorPath) {
        return;
      }
      await api.openOrchestratorPath(worktreeId, relativePath);
    },
    [api]
  );

  const value = useMemo<OrchestratorContextValue>(
    () => ({
      state,
      ensureWorktree,
      startRun,
      submitFollowUp,
      approveTask,
      commentOnTask,
      startWorkers,
      stopWorkers,
      configureWorkers,
      stopRun,
      openPath
    }),
    [approveTask, commentOnTask, configureWorkers, ensureWorktree, startRun, startWorkers, state, stopRun, stopWorkers, submitFollowUp, openPath]
  );

  return <OrchestratorContext.Provider value={value}>{children}</OrchestratorContext.Provider>;
};

export const useOrchestratorStore = (): OrchestratorContextValue => {
  const context = useContext(OrchestratorContext);
  if (!context) {
    throw new Error('useOrchestratorStore must be used within an OrchestratorProvider');
  }
  return context;
};

export const useOrchestratorWorktree = (
  worktreeId: string | null | undefined
): OrchestratorWorktreeState | undefined => {
  const { state, ensureWorktree } = useOrchestratorStore();
  const effectiveId = worktreeId ?? '';

  useEffect(() => {
    if (!effectiveId) {
      return;
    }
    ensureWorktree(effectiveId);
  }, [effectiveId, ensureWorktree]);

  if (!effectiveId) {
    return undefined;
  }

  return state.worktrees[effectiveId];
};

export const useOrchestratorTasks = (worktreeId: string | null | undefined): TaskRecord[] => {
  const state = useOrchestratorWorktree(worktreeId);
  return state?.tasks ?? [];
};

export const useOrchestratorWorkers = (worktreeId: string | null | undefined): WorkerStatus[] => {
  const state = useOrchestratorWorktree(worktreeId);
  return state?.workers ?? [];
};

const ROLE_LABELS: Record<WorkerRole, string> = {
  analyst_a: 'Analyst A',
  analyst_b: 'Analyst B',
  consensus_builder: 'Consensus',
  splitter: 'Splitter',
  implementer: 'Implementer',
  tester: 'Tester',
  reviewer: 'Reviewer'
};

export interface AgentGraphNodeView {
  id: WorkerRole;
  label: string;
  state: AgentGraphNodeState;
  status?: string;
  subtitle?: string;
  detail?: string;
  summary?: string;
  artifactPath?: string;
}

export interface AgentGraphEdgeView {
  id: string;
  source: WorkerRole;
  target: WorkerRole;
  status: 'inactive' | 'pending' | 'active' | 'done' | 'error';
}

interface AgentGraphInput {
  tasks: TaskRecord[];
  workers: WorkerStatus[];
  agentStates?: Partial<Record<WorkerRole, AgentGraphNodeState>>;
}

export const deriveAgentGraphView = ({ tasks, workers, agentStates }: AgentGraphInput): {
  nodes: AgentGraphNodeView[];
  edges: AgentGraphEdgeView[];
} => {
  const fallbackStateForRole = (role: WorkerRole): AgentGraphNodeState => {
    const roleTasks = tasks.filter((task) => task.role === role);
    const statuses = roleTasks.map((task) => task.status);
    const hasBlocked = statuses.some((status) => status === 'blocked' || status === 'error');
    const hasChangesRequested = statuses.some((status) => status === 'changes_requested');
    const hasAwaitingReview = statuses.some((status) => status === 'awaiting_review');
    const hasReady = statuses.some((status) => status === 'ready');
    const hasInProgress = statuses.some((status) => status === 'in_progress');
    const allDone = roleTasks.length > 0 && statuses.every((status) => status === 'done' || status === 'approved');
    const workerBusy = workers.some((worker) => worker.role === role && worker.state === 'working');
    const workerClaiming = workers.some((worker) => worker.role === role && worker.state === 'claiming');
    const workerHasTask = workers.some((worker) => worker.role === role && Boolean(worker.taskId));

    if (hasBlocked || hasChangesRequested) {
      return 'error';
    }
    if (workerBusy || workerClaiming || hasInProgress || workerHasTask) {
      return 'active';
    }
    if (hasReady || hasAwaitingReview) {
      return 'pending';
    }
    if (roleTasks.length > 0) {
      return allDone ? 'done' : 'pending';
    }
    return 'idle';
  };

  const truncate = (value: string | undefined, limit = 160): string | undefined => {
    if (!value) {
      return undefined;
    }
    if (value.length <= limit) {
      return value;
    }
    return `${value.slice(0, limit).trim()}…`;
  };

  const nodes: AgentGraphNodeView[] = AGENT_GRAPH_ROLES.map((role) => {
    const state = agentStates?.[role] ?? fallbackStateForRole(role);
    const roleTasks = tasks.filter((task) => task.role === role);
    const activeTask =
      roleTasks.find((task) => task.status === 'in_progress') ??
      roleTasks.find((task) => task.status === 'ready' || task.status === 'awaiting_review');
    const worker = workers.find((item) => item.role === role && item.state === 'working');
    const subtitle = truncate(activeTask?.title ?? (roleTasks.length > 0 ? `${roleTasks.length} task(s)` : undefined), 80);
    let status: string | undefined;
    if (state === 'active') {
      status = truncate(worker?.description ?? (activeTask ? `Running ${activeTask.title}` : 'Running task'), 80);
    } else if (state === 'pending') {
      status = truncate(roleTasks.length > 0 ? `${roleTasks.length} task(s) queued` : 'Awaiting upstream', 60);
    } else if (state === 'done') {
      status = 'Completed';
    } else if (state === 'error') {
      status = 'Needs attention';
    }

    const summaries = roleTasks
      .filter((task) => task.summary && (task.status === 'done' || task.status === 'approved'))
      .map((task) => task.summary as string);
    const summary = truncate(summaries[0]);

    const artifacts = roleTasks
      .filter((task) => task.artifacts.length > 0 && (task.status === 'done' || task.status === 'approved'))
      .map((task) => task.artifacts[0]);
    const artifactPath = artifacts[0];

    const detail = roleTasks.length === 0 && state === 'pending' ? 'Waiting on upstream' : undefined;

    return {
      id: role,
      label: ROLE_LABELS[role] ?? role,
      state,
      subtitle,
      status,
      summary,
      artifactPath,
      detail
    } satisfies AgentGraphNodeView;
  });

  const stateByRole = new Map(nodes.map((node) => [node.id, node.state]));

  const edges: AgentGraphEdgeView[] = AGENT_GRAPH_EDGES.map((edge) => {
    const sourceState = stateByRole.get(edge.source) ?? 'idle';
    let status: AgentGraphEdgeView['status'];
    switch (sourceState) {
      case 'active':
        status = 'active';
        break;
      case 'done':
        status = 'done';
        break;
      case 'error':
        status = 'error';
        break;
      case 'pending':
        status = 'pending';
        break;
      default:
        status = 'inactive';
    }
    return {
      id: `${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      status
    } satisfies AgentGraphEdgeView;
  });

  return { nodes, edges };
};

export const useAgentGraph = (
  worktreeId: string | null | undefined
): { nodes: AgentGraphNodeView[]; edges: AgentGraphEdgeView[] } => {
  const worktree = useOrchestratorWorktree(worktreeId);
  const tasks = worktree?.tasks ?? [];
  const workers = worktree?.workers ?? [];
  const agentStates = worktree?.metadata?.agentStates;

  return useMemo(
    () => deriveAgentGraphView({ tasks, workers, agentStates }),
    [agentStates, tasks, workers]
  );
};

export const useOrchestratorRun = (worktreeId: string | null | undefined): OrchestratorRunSummary | null => {
  const state = useOrchestratorWorktree(worktreeId);
  return state?.run ?? null;
};

export const useOrchestratorStatus = (worktreeId: string | null | undefined): {
  ready: boolean;
  error?: string;
  lastEventAt?: string;
} => {
  const state = useOrchestratorWorktree(worktreeId);
  return {
    ready: state?.ready ?? false,
    error: state?.error,
    lastEventAt: state?.lastEventAt
  };
};

export const useOrchestratorWorkerLogs = (
  worktreeId: string | null | undefined
): Record<string, string> => {
  const state = useOrchestratorWorktree(worktreeId);
  return state?.workerLogs ?? {};
};
