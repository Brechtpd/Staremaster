import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useOrchestratorStatus,
  useOrchestratorStore,
  useOrchestratorWorktree,
  useOrchestratorWorkerLogs
} from '../orchestrator/store';
import type {
  ConversationEntry,
  OrchestratorBriefingInput,
  OrchestratorFollowUpInput,
  TaskRecord,
  WorkerRole,
  WorkerStatus
} from '@shared/orchestrator';
import { AVAILABLE_MODELS, DEFAULT_COUNTS, DEFAULT_PRIORITY, WORKER_ROLES, type WorkerSpawnConfig } from '@shared/orchestrator-config';

const EMPTY_TASKS: TaskRecord[] = [];
const EMPTY_WORKERS: WorkerStatus[] = [];
const MAX_WORKERS = 4;

const ROLE_LABELS: Record<WorkerRole, string> = {
  analyst_a: 'Analyst A',
  analyst_b: 'Analyst B',
  consensus_builder: 'Consensus Builder',
  splitter: 'Splitter',
  implementer: 'Implementer',
  tester: 'Tester',
  reviewer: 'Reviewer'
};

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
  const orchestratorState = useOrchestratorWorktree(worktreeId, { ensure: visible });
  const {
    startRun,
    submitFollowUp,
    approveTask,
    commentOnTask,
    configureWorkers: configureWorkersApi
  } = useOrchestratorStore();
  const run = orchestratorState?.run ?? null;
  const tasks = orchestratorState?.tasks ?? EMPTY_TASKS;
  const workers = orchestratorState?.workers ?? EMPTY_WORKERS;
  const conversations = orchestratorState?.conversations ?? [];
  const metadata = orchestratorState?.metadata;
  type RoleSettings = { count: number; modelPriority: string[] };

  const initialSettings = useMemo(() => {
    const map: Record<WorkerRole, RoleSettings> = {} as Record<WorkerRole, RoleSettings>;
    for (const role of WORKER_ROLES) {
      const baseCount = metadata?.workerCounts?.[role] ?? DEFAULT_COUNTS[role] ?? 0;
      const priority = [...(metadata?.modelPriority?.[role] ?? DEFAULT_PRIORITY[role] ?? [])];
      while (priority.length < MAX_WORKERS) {
        priority.push(priority[priority.length - 1] ?? AVAILABLE_MODELS[2]);
      }
      map[role] = {
        count: Math.min(MAX_WORKERS, Math.max(0, baseCount)),
        modelPriority: priority.slice(0, MAX_WORKERS)
      };
    }
    return map;
  }, [metadata]);

  const [workerSettings, setWorkerSettings] = useState<Record<WorkerRole, RoleSettings>>(initialSettings);

  useEffect(() => {
    setWorkerSettings(initialSettings);
  }, [initialSettings]);
  const workerLogs = useOrchestratorWorkerLogs(worktreeId);
  const taskMap = useMemo(() => {
    const map = new Map<string, TaskRecord>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);
  const [description, setDescription] = useState('');
  const [guidance, setGuidance] = useState('');
  const [autoStartWorkers, setAutoStartWorkers] = useState(true);
  const [followUpMessage, setFollowUpMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [workersPending, setWorkersPending] = useState(false);

  useEffect(() => {
    if (status.ready) {
      onBootstrapped();
    } else {
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

  useEffect(() => {
    setWorkersPending(false);
  }, [run?.runId]);

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

  const handleCountChange = useCallback((role: WorkerRole, rawValue: number) => {
    const normalized = Number.isFinite(rawValue) ? Math.min(MAX_WORKERS, Math.max(0, Math.round(rawValue))) : 0;
    setWorkerSettings((previous) => {
      const current = previous[role] ?? { count: 0, modelPriority: [...AVAILABLE_MODELS.slice(0, MAX_WORKERS)] };
      if (current.count === normalized) {
        return previous;
      }
      return {
        ...previous,
        [role]: {
          ...current,
          count: normalized
        }
      };
    });
  }, []);

  const handleModelPriorityChange = useCallback((role: WorkerRole, index: number, model: string) => {
    setWorkerSettings((previous) => {
      const current = previous[role] ?? {
        count: 0,
        modelPriority: [...AVAILABLE_MODELS.slice(0, MAX_WORKERS)]
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
        [role]: {
          ...current,
          modelPriority: nextPriority
        }
      };
    });
  }, []);

  const handleStart = useCallback(async () => {
    if (!description.trim()) {
      setError('Describe the task before starting a run.');
      return;
    }
    const payload: OrchestratorBriefingInput = {
      description: description.trim(),
      guidance: guidance.trim() || undefined,
      autoStartWorkers
    };
    setPending(true);
    setError(null);
    setInfo(null);
    try {
      await startRun(worktreeId, payload);
      setInfo('Run seeded. Launch workers below to begin drafting.');
      setDescription('');
      setGuidance('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }, [autoStartWorkers, description, guidance, startRun, worktreeId]);

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

  const buildConfigPayload = useCallback((): WorkerSpawnConfig[] => {
    return WORKER_ROLES.map((role) => {
      const selected = (workerSettings[role]?.modelPriority ?? []).slice(0, MAX_WORKERS).filter(Boolean);
      const defaults = DEFAULT_PRIORITY[role] ?? [];
      while (selected.length < MAX_WORKERS && selected.length < defaults.length) {
        selected.push(defaults[selected.length]);
      }
      while (selected.length < MAX_WORKERS) {
        const fallbackIndex = Math.min(selected.length, AVAILABLE_MODELS.length - 1);
        selected.push(AVAILABLE_MODELS[fallbackIndex]);
      }
      return {
        role,
        count: Math.min(MAX_WORKERS, Math.max(0, workerSettings[role]?.count ?? 0)),
        modelPriority: selected
      };
    });
  }, [workerSettings]);

  const handleApplyConfiguration = useCallback(
    async (message: string) => {
      setWorkersPending(true);
      setError(null);
      setInfo(null);
      try {
        const configs = buildConfigPayload();
        await configureWorkersApi(worktreeId, configs);
        setInfo(message);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setWorkersPending(false);
      }
    },
    [buildConfigPayload, configureWorkersApi, worktreeId]
  );

  const handleApplyOnly = useCallback(async () => {
    await handleApplyConfiguration('Worker configuration applied.');
  }, [handleApplyConfiguration]);

  const handleStartWorkers = useCallback(async () => {
    await handleApplyConfiguration('Worker configuration applied. Workers launching...');
  }, [handleApplyConfiguration]);

  const handleStopWorkers = useCallback(async () => {
    setWorkersPending(true);
    setError(null);
    setInfo(null);
    try {
      const zeroConfigs = buildConfigPayload().map((config) => ({ ...config, count: 0 }));
      await configureWorkersApi(worktreeId, zeroConfigs);
      setWorkerSettings((prev) => {
        const next = { ...prev };
        for (const role of WORKER_ROLES) {
          next[role] = {
            count: 0,
            modelPriority:
              (prev[role]?.modelPriority ?? DEFAULT_PRIORITY[role] ?? AVAILABLE_MODELS.slice(0, MAX_WORKERS)).slice(0, MAX_WORKERS)
          };
        }
        return next;
      });
      setInfo('Worker shutdown requested.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorkersPending(false);
    }
  }, [buildConfigPayload, configureWorkersApi, worktreeId]);

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
            return (
              <li key={task.id}>
                <div className="orchestrator-pane__task" data-status={task.status}>
                <div>
                  <strong>{task.title}</strong>
                  <span className="orchestrator-pane__meta">[{task.role}]</span>
                </div>
                <div className="orchestrator-pane__meta">{task.artifacts[0] ?? task.prompt.slice(0, 80)}</div>
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
          {latest.map((entry: ConversationEntry) => (
            <li key={entry.id}>
              <div className="orchestrator-pane__conversation">
                <div>
                  <strong>{entry.author}</strong>
                  <span className="orchestrator-pane__meta">on task {entry.taskId}</span>
                </div>
                <div className="orchestrator-pane__meta">{new Date(entry.createdAt).toLocaleString()}</div>
                <p>{entry.message}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    );
  };

  const renderWorkers = () => {
    return (
      <section className="orchestrator-pane__section orchestrator-pane__section--workers">
        <div className="orchestrator-pane__section-header">
          <h3>Workers</h3>
        </div>
        <div className="orchestrator-pane__worker-config">
          <div className="orchestrator-pane__worker-grid">
            {WORKER_ROLES.map((role) => {
              const settings = workerSettings[role] ?? {
                count: 0,
                modelPriority: DEFAULT_PRIORITY[role]?.slice(0, MAX_WORKERS) ?? AVAILABLE_MODELS.slice(0, MAX_WORKERS)
              };
              return (
                <div key={role} className="orchestrator-pane__worker-config-card">
                  <header className="orchestrator-pane__worker-config-header">
                    <div>
                      <strong>{ROLE_LABELS[role]}</strong>
                      <span className="orchestrator-pane__meta">role id: {role}</span>
                    </div>
                    <label className="orchestrator-pane__count-input">
                      <span>Workers</span>
                      <input
                        type="number"
                        min={0}
                        max={MAX_WORKERS}
                        value={settings.count}
                        onChange={(event) => handleCountChange(role, Number.parseInt(event.target.value, 10))}
                        disabled={workersPending || pending}
                      />
                    </label>
                  </header>
                  <div className="orchestrator-pane__priority-grid">
                    {Array.from({ length: MAX_WORKERS }, (_, index) => {
                      const value = settings.modelPriority[index] ?? DEFAULT_PRIORITY[role]?.[index] ?? AVAILABLE_MODELS[Math.min(index, AVAILABLE_MODELS.length - 1)];
                      return (
                        <label key={`${role}-model-${index}`} className="orchestrator-pane__priority-select">
                          <span>Worker {index + 1}</span>
                          <select
                            value={value}
                            onChange={(event) => handleModelPriorityChange(role, index, event.target.value)}
                            disabled={workersPending || pending}
                          >
                            {AVAILABLE_MODELS.map((model) => (
                              <option key={`${role}-model-option-${index}-${model}`} value={model}>
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
          <div className="orchestrator-pane__worker-controls">
            <button type="button" onClick={handleApplyOnly} disabled={workersPending || pending}>
              Apply configuration
            </button>
            <button type="button" onClick={handleStartWorkers} disabled={workersPending || pending}>
              Apply &amp; start
            </button>
            <button type="button" onClick={handleStopWorkers} disabled={workersPending || pending}>
              Stop all
            </button>
          </div>
        </div>
        {sortedWorkers.length === 0 ? (
          <p className="orchestrator-pane__empty">
            No workers reporting yet. Use “Apply & start” to launch the in-app Codex sessions.
          </p>
        ) : (
          <ul className="orchestrator-pane__list orchestrator-pane__list--workers">
            {sortedWorkers.map((worker: WorkerStatus) => {
              const log = workerLogs[worker.id] ?? worker.logTail ?? '';
              return (
                <li key={worker.id}>
                  <div className="orchestrator-pane__worker" data-state={worker.state}>
                    <div className="orchestrator-pane__worker-header">
                      <strong>{worker.role}</strong>
                      <span className="orchestrator-pane__chip">{worker.state.replace(/_/g, ' ')}</span>
                    </div>
                    <div className="orchestrator-pane__meta">
                      Worker ID {worker.id} · Model {worker.model ?? 'default'} · Last heartbeat {formatRelativeTime(worker.lastHeartbeatAt)}
                    </div>
                    <div className="orchestrator-pane__meta">
                      Last heartbeat {formatRelativeTime(worker.lastHeartbeatAt)}
                      {worker.taskId ? ` · Task ${worker.taskId}` : ''}
                      {worker.pid ? ` · PID ${worker.pid}` : ''}
                    </div>
                    {worker.description ? (
                      <div className="orchestrator-pane__meta orchestrator-pane__meta--emphasis">{worker.description}</div>
                    ) : null}
                    {log ? <pre className="orchestrator-pane__log">{log}</pre> : null}
                  </div>
                </li>
              );
            })}
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
            <section className="orchestrator-pane__section">
              <h3>Current Run</h3>
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
                  <dt>Workers reporting</dt>
                  <dd>{sortedWorkers.length}</dd>
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

            {renderWorkers()}
            {renderTasks()}
            {renderConversations()}

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
          </div>
        ) : (
          <div className="orchestrator-pane__content">
            <section className="orchestrator-pane__section">
              <h3>Kick off a new orchestrator run</h3>
              <label className="orchestrator-pane__label" htmlFor={`orchestrator-brief-${paneId}`}>
                Task description
              </label>
              <textarea
                id={`orchestrator-brief-${paneId}`}
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Summarise the task or epic you'd like Codex analysts to tackle"
                disabled={pending}
              />
              <label className="orchestrator-pane__label" htmlFor={`orchestrator-guidance-${paneId}`}>
                Additional guidance (optional)
              </label>
              <textarea
                id={`orchestrator-guidance-${paneId}`}
                rows={3}
                value={guidance}
                onChange={(event) => setGuidance(event.target.value)}
                placeholder="Call out constraints, reviewer expectations, or edge cases"
                disabled={pending}
              />
              <label className="orchestrator-pane__checkbox">
                <input
                  type="checkbox"
                  checked={autoStartWorkers}
                  onChange={(event) => setAutoStartWorkers(event.target.checked)}
                  disabled={pending}
                />
                Auto-start analyst workers after seeding tasks
              </label>
              <div className="orchestrator-pane__actions">
                <button type="button" onClick={handleStart} disabled={pending}>
                  Start orchestrator run
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
};
