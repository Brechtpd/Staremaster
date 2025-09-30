import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useAgentGraph,
  useOrchestratorStatus,
  useOrchestratorStore,
  useOrchestratorWorktree,
  useOrchestratorWorkerLogs,
  type AgentGraphNodeView
} from '../orchestrator/store';
import type {
  ConversationEntry,
  OrchestratorBriefingInput,
  OrchestratorFollowUpInput,
  TaskRecord,
  WorkerRole,
  WorkerStatus
} from '@shared/orchestrator';
import { AVAILABLE_MODELS, DEFAULT_COUNTS, DEFAULT_PRIORITY, type WorkerSpawnConfig } from '@shared/orchestrator-config';
import { AgentFlowGraph } from './AgentFlowGraph';

const EMPTY_TASKS: TaskRecord[] = [];
const EMPTY_WORKERS: WorkerStatus[] = [];
const MAX_WORKERS = 4;
const GRAPH_ISOLATION_MODE = false;

interface WorkerTypeDefinition {
  id: string;
  label: string;
  roles: WorkerRole[];
  maxWorkers: number;
}

const WORKER_TYPES: WorkerTypeDefinition[] = [
  { id: 'analyst', label: 'Analyst', roles: ['analyst_a', 'analyst_b'], maxWorkers: 4 },
  { id: 'consensus', label: 'Consensus Builder', roles: ['consensus_builder'], maxWorkers: 2 },
  { id: 'splitter', label: 'Splitter', roles: ['splitter'], maxWorkers: 2 },
  { id: 'implementer', label: 'Implementer', roles: ['implementer'], maxWorkers: 2 },
  { id: 'tester', label: 'Tester', roles: ['tester'], maxWorkers: 2 },
  { id: 'reviewer', label: 'Reviewer', roles: ['reviewer'], maxWorkers: 4 }
];

const ROLE_TO_TYPE = new Map<WorkerRole, WorkerTypeDefinition>();
for (const definition of WORKER_TYPES) {
  for (const role of definition.roles) {
    ROLE_TO_TYPE.set(role, definition);
  }
}

const formatRelativeTime = (iso?: string | null): string => {
  if (!iso) {
    return 'never';
  }
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) {
    return iso;
  }
  const diff = Date.now() - timestamp;
  if (diff < 5_000) {
    return 'just now';
  }
  if (diff < 60_000) {
    return `${Math.round(diff / 1_000)}s ago`;
  }
  if (diff < 3_600_000) {
    return `${Math.round(diff / 60_000)}m ago`;
  }
  if (diff < 86_400_000) {
    return `${Math.round(diff / 3_600_000)}h ago`;
  }
  return new Date(timestamp).toLocaleString();
};

const formatFileLabel = (relativePath: string): string => {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    return relativePath;
  }
  return segments[segments.length - 1];
};

const formatWorkerLabel = (worker: WorkerStatus): string => {
  const roleLabel = ROLE_TO_TYPE.get(worker.role)?.label ?? worker.role;
  const base = `${roleLabel} · ${worker.id}`;
  const model = (worker.model ?? 'default').trim() || 'default';
  const reasoningRaw = worker.reasoningDepth ?? 'low';
  const reasoning = reasoningRaw
    .replace(/_/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  const details: string[] = [model];
  if (reasoning) {
    details.push(`${reasoning} reasoning`);
  }
  return `${base} (${details.join(' · ')})`;
};

interface OrchestratorPaneProps {
  worktreeId: string;
  active: boolean;
  visible: boolean;
  paneId: string;
  onBootstrapped(): void;
  onUnbootstrapped(): void;
}

export const OrchestratorPane: React.FC<OrchestratorPaneProps> = ({
  worktreeId,
  active,
  visible,
  paneId,
  onBootstrapped,
  onUnbootstrapped
}) => {
  const status = useOrchestratorStatus(visible ? worktreeId : undefined);
  const orchestratorState = useOrchestratorWorktree(worktreeId);
  const {
    startRun,
    submitFollowUp,
    approveTask,
    commentOnTask,
    startWorkers: startWorkersApi,
    configureWorkers: configureWorkersApi,
    stopRun: stopRunApi,
    openPath: openPathApi,
    readFile: readFileApi
  } = useOrchestratorStore();
  const run = orchestratorState?.run ?? null;
  const tasks = orchestratorState?.tasks ?? EMPTY_TASKS;
  const workers = orchestratorState?.workers ?? EMPTY_WORKERS;
  const conversations = orchestratorState?.conversations ?? [];
  const metadata = orchestratorState?.metadata;

  type WorkerTypeSettings = { count: number; modelPriority: string[] };

  const normalizePriority = useCallback((input: string[] | undefined) => {
    const priority = [...(input?.filter(Boolean) ?? [])];
    if (priority.length === 0) {
      priority.push(AVAILABLE_MODELS[0]);
    }
    while (priority.length < MAX_WORKERS) {
      priority.push(priority[priority.length - 1] ?? AVAILABLE_MODELS[0]);
    }
    return priority.slice(0, MAX_WORKERS);
  }, []);

  const initialSettings = useMemo(() => {
    const map: Record<string, WorkerTypeSettings> = {};
    for (const definition of WORKER_TYPES) {
      const totalCount = definition.roles.reduce(
        (acc, role) => acc + (metadata?.workerCounts?.[role] ?? DEFAULT_COUNTS[role] ?? 0),
        0
      );
      const sourceRole = definition.roles[0];
      const basePriority = metadata?.modelPriority?.[sourceRole] ?? DEFAULT_PRIORITY[sourceRole] ?? AVAILABLE_MODELS;
      map[definition.id] = {
        count: Math.min(definition.maxWorkers, Math.max(0, totalCount)),
        modelPriority: normalizePriority(basePriority)
      };
    }
    return map;
  }, [metadata, normalizePriority]);

  const [workerTypeSettings, setWorkerTypeSettings] = useState<Record<string, WorkerTypeSettings>>(initialSettings);

  useEffect(() => {
    setWorkerTypeSettings(initialSettings);
  }, [initialSettings]);
  const workerLogs = useOrchestratorWorkerLogs(worktreeId);
  const activity = orchestratorState?.activity ?? [];
  const agentGraph = useAgentGraph(worktreeId);
  const taskMap = useMemo(() => {
    const map = new Map<string, TaskRecord>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);
  const [description, setDescription] = useState('');
  const [autoStartWorkers, setAutoStartWorkers] = useState(true);
  const [followUpMessage, setFollowUpMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [logViewer, setLogViewer] = useState<{
    title: string;
    path: string;
    content: string;
  } | null>(null);
  const [logViewerLoading, setLogViewerLoading] = useState(false);
  const [logViewerError, setLogViewerError] = useState<string | null>(null);

  const openRelativePath = useCallback(
    async (relativePath: string) => {
      if (!relativePath || !openPathApi) {
        return;
      }
      try {
        const result = await openPathApi(worktreeId, relativePath);
        if (typeof result === 'string' && result.trim().length > 0) {
          setError(result.trim());
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [openPathApi, setError, worktreeId]
  );

  const handleOpenLog = useCallback(
    async (node: AgentGraphNodeView) => {
      if (!node.conversationPath) {
        setInfo('No log available for this worker yet.');
        return;
      }
      setLogViewer({ title: `${node.label} · Log`, path: node.conversationPath, content: '' });
      setLogViewerLoading(true);
      setLogViewerError(null);
      try {
        const contents = await readFileApi(worktreeId, node.conversationPath);
        setLogViewer({ title: `${node.label} · Log`, path: node.conversationPath, content: contents });
      } catch (cause) {
        setLogViewerError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLogViewerLoading(false);
      }
    },
    [readFileApi, setInfo, worktreeId]
  );

  const handleCloseLog = useCallback(() => {
    setLogViewer(null);
    setLogViewerLoading(false);
    setLogViewerError(null);
  }, []);

  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (status.ready) {
      if (!bootstrappedRef.current) {
        bootstrappedRef.current = true;
        onBootstrapped();
      }
    } else if (bootstrappedRef.current) {
      bootstrappedRef.current = false;
      onUnbootstrapped();
    }
  }, [onBootstrapped, onUnbootstrapped, status.ready]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setError(null);
    setInfo(null);
  }, [visible, run?.runId]);

  const groupedTasks = useMemo(() => {
    const byStatus = new Map<string, TaskRecord[]>();
    for (const task of tasks) {
      const bucket = byStatus.get(task.status) ?? [];
      bucket.push(task);
      byStatus.set(task.status, bucket);
    }
    return Array.from(byStatus.entries()).map(([statusLabel, entries]) => ({
      statusLabel,
      entries: entries.sort((a, b) => a.title.localeCompare(b.title))
    }));
  }, [tasks]);

  const sortedWorkers = useMemo(() => {
    return [...workers].sort((a, b) => a.role.localeCompare(b.role));
  }, [workers]);

  const activeWorkers = useMemo(() => {
    return sortedWorkers.filter((worker) => worker.state === 'working');
  }, [sortedWorkers]);

  const workerGroups = useMemo(() => {
    const groups = new Map<string, WorkerStatus[]>();
    for (const worker of activeWorkers) {
      const typeId = ROLE_TO_TYPE.get(worker.role)?.id ?? worker.role;
      const bucket = groups.get(typeId) ?? [];
      bucket.push(worker);
      groups.set(typeId, bucket);
    }
    return Array.from(groups.entries());
  }, [activeWorkers]);

  const handleCountChange = useCallback((typeId: string, rawValue: number, maxWorkers: number) => {
    const normalized = Number.isFinite(rawValue)
      ? Math.min(maxWorkers, Math.max(0, Math.round(rawValue)))
      : 0;
    setWorkerTypeSettings((previous) => {
      const definition = WORKER_TYPES.find((type) => type.id === typeId);
      const current = previous[typeId] ?? {
        count: 0,
        modelPriority: normalizePriority(
          definition ? DEFAULT_PRIORITY[definition.roles[0]] : undefined
        )
      };
      if (current.count === normalized) {
        return previous;
      }
      return {
        ...previous,
        [typeId]: {
          ...current,
          count: normalized
        }
      };
    });
  }, [normalizePriority]);

  const handleModelPriorityChange = useCallback((typeId: string, index: number, model: string) => {
    setWorkerTypeSettings((previous) => {
      const definition = WORKER_TYPES.find((type) => type.id === typeId);
      const current = previous[typeId] ?? {
        count: 0,
        modelPriority: normalizePriority(
          definition ? DEFAULT_PRIORITY[definition.roles[0]] : undefined
        )
      };
      const nextPriority = current.modelPriority.slice(0, MAX_WORKERS);
      if (nextPriority[index] === model) {
        return previous;
      }
      while (nextPriority.length < MAX_WORKERS) {
        nextPriority.push(AVAILABLE_MODELS[Math.min(nextPriority.length, AVAILABLE_MODELS.length - 1)]);
      }
      nextPriority[index] = model;
      return {
        ...previous,
        [typeId]: {
          ...current,
          modelPriority: nextPriority
        }
      };
    });
  }, [normalizePriority]);

  const buildConfigPayload = useCallback((): WorkerSpawnConfig[] => {
    const configs: WorkerSpawnConfig[] = [];
    for (const definition of WORKER_TYPES) {
      const settings = workerTypeSettings[definition.id] ?? {
        count: Math.min(definition.maxWorkers, 0),
        modelPriority: normalizePriority(DEFAULT_PRIORITY[definition.roles[0]])
      };
      const normalizedPriority = normalizePriority(settings.modelPriority);
      const allocations = definition.roles.map(() => 0);
      let remaining = Math.min(definition.maxWorkers, Math.max(0, settings.count));
      let index = 0;
      while (remaining > 0 && definition.roles.length > 0) {
        if (allocations[index] < MAX_WORKERS) {
          allocations[index] += 1;
          remaining -= 1;
        }
        index = (index + 1) % definition.roles.length;
      }
      definition.roles.forEach((role, roleIndex) => {
        configs.push({
          role,
          count: allocations[roleIndex],
          modelPriority: normalizedPriority
        });
      });
    }
    return configs;
  }, [normalizePriority, workerTypeSettings]);

  const handleStart = useCallback(async () => {
    if (!description.trim()) {
      setError('Describe the task before starting a run.');
      return;
    }
    const configs = buildConfigPayload();
    const payload: OrchestratorBriefingInput = {
      description: description.trim(),
      autoStartWorkers: false
    };
    setPending(true);
    setError(null);
    setInfo(null);
    try {
      await startRun(worktreeId, payload);
      await configureWorkersApi(worktreeId, configs);
      if (autoStartWorkers) {
        await startWorkersApi(worktreeId, configs);
        setInfo('Run seeded and workers launching.');
      } else {
        setInfo('Run seeded. Launch workers below when ready.');
      }
      setDescription('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [autoStartWorkers, buildConfigPayload, configureWorkersApi, description, startRun, startWorkersApi, worktreeId]);

  const handleFollowUp = useCallback(async () => {
    if (!followUpMessage.trim()) {
      setError('Provide follow-up guidance before submitting.');
      return;
    }
    const payload: OrchestratorFollowUpInput = {
      description: followUpMessage.trim(),
      guidance: undefined
    };
    setPending(true);
    setError(null);
    setInfo(null);
    try {
      await submitFollowUp(worktreeId, payload);
      setInfo('Follow-up sent to orchestrator.');
      setFollowUpMessage('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [followUpMessage, submitFollowUp, worktreeId]);

  const handleApproveTask = useCallback(
    async (taskId: string) => {
      const approver = window.prompt('Approve task as (role name)', 'reviewer');
      if (!approver) {
        return;
      }
      setPending(true);
      setError(null);
      setInfo(null);
      try {
        await approveTask(worktreeId, taskId, approver.trim());
        setInfo(`Approved task ${taskId} as ${approver.trim()}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(false);
      }
    },
    [approveTask, worktreeId]
  );

  const handleCommentTask = useCallback(
    async (taskId: string) => {
      const author = window.prompt('Comment author', 'reviewer');
      if (!author) {
        return;
      }
      const message = window.prompt('Comment body');
      if (!message || !message.trim()) {
        return;
      }
      setPending(true);
      setError(null);
      setInfo(null);
      try {
        await commentOnTask(worktreeId, {
          taskId,
          author: author.trim(),
          message: message.trim()
        });
        setInfo(`Comment sent to task ${taskId}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(false);
      }
    },
    [commentOnTask, worktreeId]
  );

  const handleStopRun = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await stopRunApi(worktreeId);
      setInfo('Orchestrator run stopped.');
      setFollowUpMessage('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [stopRunApi, worktreeId]);

  const renderTasks = () => {
    if (groupedTasks.length === 0) {
      return <p className="orchestrator-pane__empty">No tasks detected yet.</p>;
    }
    return groupedTasks.map((group) => (
      <section key={group.statusLabel} className="orchestrator-pane__section">
        <h3>{group.statusLabel.replace(/_/g, ' ')}</h3>
        <ul className="orchestrator-pane__list">
          {group.entries.map((task) => {
            const waitingOn = (task.dependsOn ?? []).filter((dependencyId) => {
              const dependency = taskMap.get(dependencyId);
              if (!dependency) {
                return true;
              }
              return dependency.status !== 'done' && dependency.status !== 'approved';
            });
            const artifactPaths = (task.artifacts ?? []).filter((artifact) => Boolean(artifact));
            const quickOpenTargets: Array<{ key: string; label: string; path: string }> = [];
            for (const artifact of artifactPaths) {
              const label = formatFileLabel(artifact);
              quickOpenTargets.push({
                key: `artifact-${task.id}-${artifact}`,
                label,
                path: artifact
              });
            }
            if (task.conversationPath) {
              quickOpenTargets.push({
                key: `conversation-${task.id}`,
                label: 'Conversation log',
                path: task.conversationPath
              });
            }
            return (
              <li key={task.id}>
                <div className="orchestrator-pane__task" data-status={task.status}>
                  <div>
                    <strong>{task.title}</strong>
                    <span className="orchestrator-pane__meta">[{task.role}]</span>
                  </div>
                  <div className="orchestrator-pane__meta orchestrator-pane__meta--muted">
                    {task.prompt ? task.prompt.slice(0, 160) : 'No prompt available'}
                  </div>
                  {quickOpenTargets.length > 0 ? (
                    <div className="orchestrator-pane__artifact-row">
                      {quickOpenTargets.map((target) => (
                        <button
                          key={target.key}
                          type="button"
                          className="orchestrator-pane__artifact-button"
                          onClick={() => void openRelativePath(target.path)}
                          title={target.path}
                        >
                          {target.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {waitingOn.length > 0 ? (
                    <div className="orchestrator-pane__meta orchestrator-pane__meta--warning">
                      Waiting on {waitingOn.map((id) => taskMap.get(id)?.title ?? id).join(', ')}
                    </div>
                  ) : null}
                  {task.approvalsRequired > 0 ? (
                    <div className="orchestrator-pane__meta">
                      Approvals {task.approvals.length}/{task.approvalsRequired}
                      {task.approvals.length > 0 ? ` (${task.approvals.join(', ')})` : ''}
                    </div>
                  ) : null}
                  <div className="orchestrator-pane__actions-row">
                    {task.approvalsRequired > task.approvals.length ? (
                      <button
                        type="button"
                        className="orchestrator-pane__approve"
                        onClick={() => handleApproveTask(task.id)}
                        disabled={pending}
                      >
                        Approve…
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="orchestrator-pane__comment"
                      onClick={() => handleCommentTask(task.id)}
                      disabled={pending}
                    >
                      Comment…
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    ));
  };

  const renderConversations = () => {
    if (conversations.length === 0) {
      return null;
    }
    const latest = conversations
      .slice()
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
      .slice(0, 8);
    return (
      <section className="orchestrator-pane__section">
        <h3>Recent Comments</h3>
        <ul className="orchestrator-pane__list orchestrator-pane__list--conversations">
          {latest.map((entry: ConversationEntry) => {
            const conversationTask = taskMap.get(entry.taskId);
            const conversationPath = conversationTask?.conversationPath;
            return (
              <li key={entry.id}>
                <div className="orchestrator-pane__conversation">
                  <div className="orchestrator-pane__conversation-header">
                    <div>
                      <strong>{entry.author}</strong>
                      <span className="orchestrator-pane__meta">on task {entry.taskId}</span>
                    </div>
                    {conversationPath ? (
                      <button
                        type="button"
                        className="orchestrator-pane__artifact-button orchestrator-pane__artifact-button--small"
                        onClick={() => void openRelativePath(conversationPath)}
                        title={conversationPath}
                      >
                        Open log
                      </button>
                    ) : null}
                  </div>
                  <div className="orchestrator-pane__meta">{new Date(entry.createdAt).toLocaleString()}</div>
                  <p>{entry.message}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    );
  };

  const renderWorkers = () => {
    if (activeWorkers.length === 0) {
      return null;
    }
    return (
      <section className="orchestrator-pane__card orchestrator-pane__card--activity">
        <h3>Active agents</h3>
        <div className="orchestrator-pane__worker-activity">
          {workerGroups.map(([typeId, group]) => {
            const definition = WORKER_TYPES.find((type) => type.id === typeId);
            const label = definition?.label ?? typeId;
            return (
              <div key={typeId} className="orchestrator-pane__worker-group">
                <header className="orchestrator-pane__worker-group-header">
                  <div>
                    <strong>{label}</strong>
                    <span className="orchestrator-pane__meta">{group.length} active</span>
                  </div>
                  <span className="orchestrator-pane__meta">
                    Roles: {definition ? definition.roles.join(', ') : group.map((worker) => worker.role).join(', ')}
                  </span>
                </header>
                <ul className="orchestrator-pane__worker-list">
                  {group.map((worker) => {
                    const log = workerLogs[worker.id] ?? worker.logTail ?? '';
                    const workerLabel = formatWorkerLabel(worker);
                    const task = worker.taskId ? taskMap.get(worker.taskId) : undefined;
                    const taskTitle = worker.taskId
                      ? task?.title ?? `Task ${worker.taskId}`
                      : 'No task assigned';
                    const taskSummary = task?.prompt ? task.prompt.slice(0, 160) : null;
                    const workerArtifacts = (task?.artifacts ?? []).filter(Boolean);
                    const conversationPath = task?.conversationPath;
                    return (
                      <li key={worker.id}>
                        <div className="orchestrator-pane__worker" data-state={worker.state}>
                          <div className="orchestrator-pane__worker-header">
                            <strong>{workerLabel}</strong>
                            <span className="orchestrator-pane__chip">{worker.state.replace(/_/g, ' ')}</span>
                          </div>
                          <div className="orchestrator-pane__meta">Last heartbeat {formatRelativeTime(worker.lastHeartbeatAt)}</div>
                          <div className="orchestrator-pane__meta">
                            Working on: {taskTitle}
                            {worker.pid ? ` · PID ${worker.pid}` : ''}
                          </div>
                          {taskSummary ? (
                            <div className="orchestrator-pane__meta orchestrator-pane__meta--muted">{taskSummary}</div>
                          ) : null}
                          {worker.description ? (
                            <div className="orchestrator-pane__meta orchestrator-pane__meta--emphasis">{worker.description}</div>
                          ) : null}
                          {workerArtifacts.length > 0 || conversationPath ? (
                            <div className="orchestrator-pane__artifact-row">
                              {workerArtifacts.map((artifact) => (
                                <button
                                  key={`${worker.id}-${artifact}`}
                                  type="button"
                                  className="orchestrator-pane__artifact-button orchestrator-pane__artifact-button--small"
                                  onClick={() => void openRelativePath(artifact)}
                                  title={artifact}
                                >
                                  {formatFileLabel(artifact)}
                                </button>
                              ))}
                              {conversationPath ? (
                                <button
                                  type="button"
                                  className="orchestrator-pane__artifact-button orchestrator-pane__artifact-button--small"
                                  onClick={() => void openRelativePath(conversationPath)}
                                  title={conversationPath}
                                >
                                  Conversation
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                          {log ? <pre className="orchestrator-pane__log">{log}</pre> : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  const renderActivityLog = () => {
    const recent = activity.slice(-25).reverse();
    return (
      <section className="orchestrator-pane__card orchestrator-pane__card--activity">
        <h3>Activity</h3>
        {recent.length === 0 ? (
          <p className="orchestrator-pane__empty">No activity yet.</p>
        ) : (
          <ul className="orchestrator-pane__activity-list">
            {recent.map((entry) => (
              <li key={entry.id}>
                <div className="orchestrator-pane__activity-row">
                  <span className="orchestrator-pane__activity-timestamp">{formatRelativeTime(entry.occurredAt)}</span>
                  <span className="orchestrator-pane__activity-kind">[{entry.kind}]</span>
                  <span className="orchestrator-pane__activity-message">{entry.message}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <div className="orchestrator-pane" data-active={active} data-visible={visible}>
      <div className="orchestrator-pane__layout">
        <header className="orchestrator-pane__header">
          <h2>Task Orchestrator</h2>
          {status.error ? <p className="orchestrator-pane__error">{status.error}</p> : null}
          {error ? <p className="orchestrator-pane__error">{error}</p> : null}
          {info ? <p className="orchestrator-pane__info">{info}</p> : null}
        </header>

        {!status.ready ? (
          <div className="orchestrator-pane__empty">Loading orchestrator state…</div>
        ) : run ? (
          <div className="orchestrator-pane__content">
            {GRAPH_ISOLATION_MODE ? null : (
              <section className="orchestrator-pane__card orchestrator-pane__card--summary">
                <div className="orchestrator-pane__section-header">
                  <h3>Current run</h3>
                  <button
                    type="button"
                    className="orchestrator-pane__ghost-button"
                    onClick={handleStopRun}
                    disabled={pending}
                  >
                    Stop run
                  </button>
                </div>
                <dl className="orchestrator-pane__summary">
                  <div>
                    <dt>Run ID</dt>
                    <dd>{run.runId}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{run.status}</dd>
                  </div>
                  <div>
                    <dt>Last activity</dt>
                    <dd>{formatRelativeTime(status.lastEventAt)}</dd>
                  </div>
                  <div>
                    <dt>Active workers</dt>
                    <dd>{activeWorkers.length}</dd>
                  </div>
                  <div>
                    <dt>Implementer lock</dt>
                    <dd>{metadata?.implementerLockHeldBy ? `held by ${metadata.implementerLockHeldBy}` : 'idle'}</dd>
                  </div>
                  <div>
                    <dt>Description</dt>
                    <dd>{run.description}</dd>
                  </div>
                  {run.guidance ? (
                    <div>
                      <dt>Guidance</dt>
                      <dd>{run.guidance}</dd>
                    </div>
                  ) : null}
                </dl>
              </section>
            )}

            {agentGraph.nodes.length > 0 ? (
              <section className="orchestrator-pane__card orchestrator-pane__card--graph">
                <div className="orchestrator-pane__section-header">
                  <h3>Workflow</h3>
                  <div className="agent-flow__legend">
                    <span className="agent-flow__legend-item agent-flow__legend-item--active">Active</span>
                    <span className="agent-flow__legend-item agent-flow__legend-item--pending">Pending</span>
                    <span className="agent-flow__legend-item agent-flow__legend-item--done">Done</span>
                    <span className="agent-flow__legend-item agent-flow__legend-item--error">Needs attention</span>
                  </div>
                  {GRAPH_ISOLATION_MODE ? (
                    <button
                      type="button"
                      className="orchestrator-pane__ghost-button"
                      onClick={handleStopRun}
                      disabled={pending}
                    >
                      Stop run
                    </button>
                  ) : null}
                </div>
                <AgentFlowGraph
                  nodes={agentGraph.nodes}
                  edges={agentGraph.edges}
                  onOpenArtifact={(path) => void openRelativePath(path)}
                  onOpenLog={(node) => void handleOpenLog(node)}
                  visible={visible}
                />
              </section>
            ) : null}

            {GRAPH_ISOLATION_MODE ? null : (
              <>
                {renderWorkers()}
                {renderTasks()}
                {renderConversations()}
                {renderActivityLog()}

                <section className="orchestrator-pane__section">
                  <h3>Follow-up</h3>
                  <textarea
                    rows={3}
                    placeholder="Share follow-up instructions or clarifications"
                    value={followUpMessage}
                    onChange={(event) => setFollowUpMessage(event.target.value)}
                    disabled={pending}
                  />
                  <div className="orchestrator-pane__actions">
                    <button type="button" onClick={handleFollowUp} disabled={pending || !followUpMessage.trim()}>
                      Send follow-up
                    </button>
                  </div>
                </section>
              </>
            )}
          </div>
        ) : (
          <div className="orchestrator-pane__content">
            <section className="orchestrator-pane__card orchestrator-pane__card--form">
              <h3>Kick off a new orchestrator run</h3>
              <label className="orchestrator-pane__label" htmlFor={`orchestrator-brief-${paneId}`}>
                Task briefing
              </label>
              <textarea
                id={`orchestrator-brief-${paneId}`}
                rows={10}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe the task, desired deliverables, and any key constraints"
                className="orchestrator-pane__textarea"
                disabled={pending}
              />
              <div className="orchestrator-pane__worker-config">
                <h4>Worker configuration</h4>
                <div className="orchestrator-pane__worker-grid">
                  {WORKER_TYPES.map((type) => {
                    const settings = workerTypeSettings[type.id] ?? {
                      count: 0,
                      modelPriority: normalizePriority(DEFAULT_PRIORITY[type.roles[0]])
                    };
                    return (
                      <div key={type.id} className="orchestrator-pane__worker-config-card">
                        <header className="orchestrator-pane__worker-config-header">
                          <div>
                            <strong>{type.label}</strong>
                            <span className="orchestrator-pane__meta">roles: {type.roles.join(', ')}</span>
                          </div>
                    <label className="orchestrator-pane__count-input">
                      <span>Workers</span>
                      <select
                        value={settings.count}
                        onChange={(event) => handleCountChange(type.id, Number.parseInt(event.target.value, 10), type.maxWorkers)}
                        disabled={pending}
                      >
                        {Array.from({ length: type.maxWorkers + 1 }, (_, value) => (
                          <option key={`${type.id}-count-${value}`} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                        </header>
                        <div className="orchestrator-pane__priority-grid">
                          {Array.from({ length: MAX_WORKERS }, (_, index) => {
                            const fallbackPriority = normalizePriority(DEFAULT_PRIORITY[type.roles[0]]);
                            const value =
                              settings.modelPriority[index] ??
                              fallbackPriority[index] ??
                              AVAILABLE_MODELS[Math.min(index, AVAILABLE_MODELS.length - 1)];
                            return (
                              <label key={`${type.id}-model-${index}`} className="orchestrator-pane__priority-select">
                                <span>Priority {index + 1}</span>
                        <select
                          value={value}
                          onChange={(event) => handleModelPriorityChange(type.id, index, event.target.value)}
                          disabled={pending}
                        >
                                  {AVAILABLE_MODELS.map((model) => (
                                    <option key={`${type.id}-model-option-${index}-${model}`} value={model}>
                                      {model}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="orchestrator-pane__form-footer">
                <label className="orchestrator-pane__checkbox">
                  <input
                    type="checkbox"
                    checked={autoStartWorkers}
                    onChange={(event) => setAutoStartWorkers(event.target.checked)}
                    disabled={pending}
                  />
                  Auto-start workers once tasks are seeded
                </label>
                <button type="button" onClick={handleStart} disabled={pending || !description.trim()}>
                  Start orchestrator run
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
      {logViewer ? (
        <div className="modal-backdrop">
          <div className="modal orchestrator-pane__log-modal">
            <header className="orchestrator-pane__log-modal-header">
              <div>
                <h3>{logViewer.title}</h3>
                <p className="orchestrator-pane__meta orchestrator-pane__meta--muted">{logViewer.path}</p>
              </div>
              <button type="button" className="orchestrator-pane__ghost-button" onClick={handleCloseLog}>
                Close
              </button>
            </header>
            <div className="orchestrator-pane__log-modal-body">
              {logViewerLoading ? (
                <p className="orchestrator-pane__meta">Loading log…</p>
              ) : logViewerError ? (
                <p className="orchestrator-pane__error">{logViewerError}</p>
              ) : logViewer.content.trim().length === 0 ? (
                <p className="orchestrator-pane__meta">No log content available yet.</p>
              ) : (
                <pre className="orchestrator-pane__log-modal-content">{logViewer.content}</pre>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
