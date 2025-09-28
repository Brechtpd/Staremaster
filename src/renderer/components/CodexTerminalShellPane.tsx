import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RendererApi } from '@shared/api';
import type { WorktreeDescriptor } from '@shared/ipc';
import { CodexTerminal, type CodexTerminalHandle } from './CodexTerminal';
import type { DerivedCodexSession } from '../codex-model';

interface CodexTerminalShellPaneProps {
  api: RendererApi;
  worktree: WorktreeDescriptor;
  sessionWorktreeId: string | null;
  session: DerivedCodexSession | undefined;
  active: boolean;
  visible: boolean;
  paneId?: string;
  onNotification(message: string | null): void;
  onUserInput?(data: string): void;
  onBootstrapped?(): void;
  onUnbootstrapped?(): void;
  initialScrollState?: { position: number; atBottom: boolean };
  onScrollStateChange?(worktreeId: string, state: { position: number; atBottom: boolean }): void;
}

type TerminalLifecycle = 'idle' | 'starting' | 'running' | 'exited';

const buildResumeCommand = (sessionId: string | null | undefined): string | null =>
  sessionId ? `codex resume --yolo ${sessionId}` : null;

const isScrolledToBottom = (terminal: CodexTerminalHandle | null): boolean => {
  if (!terminal) {
    return true;
  }
  return terminal.isScrolledToBottom();
};

export const CodexTerminalShellPane: React.FC<CodexTerminalShellPaneProps> = ({
  api,
  worktree,
  sessionWorktreeId,
  session,
  active,
  visible,
  paneId,
  onNotification,
  onUserInput,
  onBootstrapped,
  onUnbootstrapped,
  initialScrollState,
  onScrollStateChange
}) => {
  const [descriptorPid, setDescriptorPid] = useState<number | null>(null);
  const [status, setStatus] = useState<TerminalLifecycle>('idle');
  const [lastExit, setLastExit] = useState<{ code: number | null; signal: string | null } | null>(null);

  const terminalRef = useRef<CodexTerminalHandle | null>(null);
  const paneIdRef = useRef<string | undefined>(paneId);
  const visibleRef = useRef<boolean>(visible);
  const bootstrappedRef = useRef<boolean>(false);
  const startRef = useRef<number | null>(null);
  const previousWorktreeIdRef = useRef<string>(worktree.id);
  // We stream Codex output live only; no snapshot/delta replay.
  const scrollPositionRef = useRef<number>(0);
  const wasAtBottomRef = useRef<boolean>(true);
  const errorRef = useRef<string | null>(null);
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const initialScrollRestoredRef = useRef<boolean>(false);
  const scrollChangeCallbackRef = useRef<typeof onScrollStateChange>(onScrollStateChange);
  const [latestSessionId, setLatestSessionId] = useState<string | null>(session?.codexSessionId ?? null);
  const resolvedWorktreeId = sessionWorktreeId ?? (worktree.id.startsWith('project-root:') ? null : worktree.id);
  const codexUnavailable = resolvedWorktreeId == null;
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionPickerLoading, setSessionPickerLoading] = useState(false);
  const [sessionPickerError, setSessionPickerError] = useState<string | null>(null);
  const [sessionChoices, setSessionChoices] = useState<Array<{ id: string; mtimeMs: number; preview: string }>>([]);
  const [sessionSummaries, setSessionSummaries] = useState<Record<string, string>>({});
  const [sessionSummariesLoading, setSessionSummariesLoading] = useState<Record<string, boolean>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const autoPickerPromptedRef = useRef(false);
  const displayedSessionId = session?.codexSessionId ?? latestSessionId;
  const resumeCommandDisplay = buildResumeCommand(displayedSessionId);

  const closeSessionPicker = useCallback(() => {
    setSessionPickerOpen(false);
  }, []);

  const openSessionPicker = useCallback(async () => {
    if (!resolvedWorktreeId) {
      return;
    }
    setSessionPickerLoading(true);
    setSessionPickerError(null);
    try {
      const options = await api.listCodexSessions(resolvedWorktreeId);
      setSessionChoices(options);
      setSelectedSessionId(options[0]?.id ?? null);
      setSessionSummaries({});
      setSessionSummariesLoading({});
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list Codex sessions';
      setSessionPickerError(message);
      setSessionChoices([]);
      setSelectedSessionId(null);
    } finally {
      setSessionPickerLoading(false);
      setSessionPickerOpen(true);
    }
  }, [api, resolvedWorktreeId]);

  const handleConfirmSession = useCallback(async () => {
    if (!resolvedWorktreeId) {
      return;
    }
    try {
      const chosen = selectedSessionId ?? undefined;
      const result = await api.refreshCodexSessionId(resolvedWorktreeId, chosen);
      setLatestSessionId(result);
      closeSessionPicker();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update Codex session';
      onNotification(message);
    }
  }, [api, closeSessionPicker, onNotification, resolvedWorktreeId, selectedSessionId]);

  const handleStartNewSession = useCallback(async () => {
    if (!resolvedWorktreeId) {
      return;
    }
    try {
      await api.refreshCodexSessionId(resolvedWorktreeId, null);
      setLatestSessionId(null);
      closeSessionPicker();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clear Codex session';
      onNotification(message);
    }
  }, [api, closeSessionPicker, onNotification, resolvedWorktreeId]);

  const SUMMARY_PREFETCH_LIMIT = 10;

  useEffect(() => {
    if (!sessionPickerOpen || !resolvedWorktreeId) {
      return;
    }
    const summarizer = api.summarizeCodexOutput;
    const relevantChoices = sessionChoices.filter((choice, index) => {
      if (index < SUMMARY_PREFETCH_LIMIT) {
        return true;
      }
      return choice.id === selectedSessionId;
    });
    relevantChoices.forEach((choice) => {
      if (sessionSummaries[choice.id] || sessionSummariesLoading[choice.id]) {
        return;
      }
      if (!choice.preview.trim()) {
        setSessionSummaries((prev) => ({ ...prev, [choice.id]: 'No recent Codex output.' }));
        return;
      }
      if (!summarizer) {
        const preview = choice.preview.trim();
        setSessionSummaries((prev) => ({ ...prev, [choice.id]: preview ? preview : 'No recent Codex output.' }));
        return;
      }
      setSessionSummariesLoading((prev) => ({ ...prev, [choice.id]: true }));
      void Promise.resolve(summarizer(resolvedWorktreeId, choice.preview))
        .then((summary) => {
          const preview = choice.preview.trim();
          const resolvedSummary = summary?.trim();
          setSessionSummaries((prev) => ({ ...prev, [choice.id]: resolvedSummary ? resolvedSummary : preview || 'No recent Codex output.' }));
        })
        .catch(() => {
          const preview = choice.preview.trim();
          setSessionSummaries((prev) => ({ ...prev, [choice.id]: preview ? preview : 'No recent Codex output.' }));
        })
        .finally(() => {
          setSessionSummariesLoading((prev) => {
            const next = { ...prev };
            delete next[choice.id];
            return next;
          });
        });
    });
  }, [api.summarizeCodexOutput, resolvedWorktreeId, sessionChoices, sessionPickerOpen, sessionSummaries, sessionSummariesLoading, selectedSessionId]);

  const renderSessionSummary = useCallback(
    (choiceId: string, preview: string): { title: string; abstract: string } => {
      const resolvedSummary = sessionSummaries[choiceId] ?? preview.trim();
      const normalized = resolvedSummary.replace(/\s+/g, ' ').trim();
      const defaultTitle = 'Codex activity';
      if (!normalized) {
        return {
          title: defaultTitle,
          abstract: 'No recent Codex output.'
        };
      }
      const lines = normalized.split(/[.!?]\s+/).filter(Boolean);
      const titleSeed = lines[0] ?? normalized;
      const abstractSeed = lines.slice(1).join('. ') || normalized;
      return {
        title: titleSeed.length > 120 ? `${titleSeed.slice(0, 117)}…` : titleSeed,
        abstract: abstractSeed
      };
    },
    [sessionSummaries]
  );

  useEffect(() => {
    scrollChangeCallbackRef.current = onScrollStateChange;
  }, [onScrollStateChange]);

  useEffect(() => {
    paneIdRef.current = paneId;
  }, [paneId]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    if (!resolvedWorktreeId || session?.codexSessionId || autoPickerPromptedRef.current || !visible) {
      return;
    }
    autoPickerPromptedRef.current = true;
    void openSessionPicker();
  }, [openSessionPicker, resolvedWorktreeId, session?.codexSessionId, visible]);

  useEffect(() => {
    if (initialScrollRestoredRef.current) {
      return;
    }
    if (initialScrollState) {
      scrollPositionRef.current = initialScrollState.position;
      wasAtBottomRef.current = initialScrollState.atBottom;
      initialScrollRestoredRef.current = true;
    }
  }, [initialScrollState]);

  useEffect(() => {
    if (session?.codexSessionId) {
      setLatestSessionId(session.codexSessionId);
    } else if (worktree.id !== previousWorktreeIdRef.current) {
      setLatestSessionId(null);
    }
  }, [session?.codexSessionId, worktree.id]);

  useEffect(() => {
    if (!resolvedWorktreeId || session?.codexSessionId) {
      return;
    }
    let cancelled = false;
    api
      .refreshCodexSessionId(resolvedWorktreeId)
      .then((id) => {
        if (!cancelled && id) {
          setLatestSessionId(id);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Failed to refresh Codex session id';
          onNotification(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, onNotification, resolvedWorktreeId, session?.codexSessionId]);

  const handleTerminalScroll = useCallback(
    ({ position, atBottom }: { position: number; atBottom: boolean }) => {
      wasAtBottomRef.current = atBottom;
      scrollPositionRef.current = position;
      const cb = scrollChangeCallbackRef.current;
      if (cb) {
        cb(worktree.id, { position, atBottom });
      }
    },
    [worktree.id]
  );

  const updateScrollTracking = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    handleTerminalScroll({
      position: terminal.getScrollPosition(),
      atBottom: isScrolledToBottom(terminal)
    });
  }, [handleTerminalScroll]);

  const restoreViewport = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (wasAtBottomRef.current) {
      terminal.scrollToBottom();
    } else {
      const current = terminal.getScrollPosition();
      const target = scrollPositionRef.current;
      const delta = target - current;
      if (delta !== 0) {
        terminal.scrollLines(delta);
      }
    }
    terminal.forceRender?.();
    updateScrollTracking();
  }, [updateScrollTracking]);

  // When switching to a different worktree in the same pane, allow
  // restoring the new worktree's initial scroll state on first render.
  useEffect(() => {
    const previousId = previousWorktreeIdRef.current;
    if (previousId && scrollChangeCallbackRef.current && previousId !== worktree.id) {
      const terminal = terminalRef.current;
      if (terminal) {
        try {
          const position = terminal.getScrollPosition();
          const atBottom = isScrolledToBottom(terminal);
          scrollChangeCallbackRef.current(previousId, { position, atBottom });
        } catch {
          // ignore
        }
      }
    }
    previousWorktreeIdRef.current = worktree.id;
    initialScrollRestoredRef.current = false;
    wasAtBottomRef.current = initialScrollState?.atBottom ?? true;
    scrollPositionRef.current = initialScrollState?.position ?? 0;
    if (visibleRef.current) {
      requestAnimationFrame(() => restoreViewport());
    }
  }, [initialScrollState, restoreViewport, worktree.id]);

  const writeChunk = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      // Heuristic de-duplication: Codex occasionally reprints the banner
      // very early at startup. Trim a second banner if it appears again
      // in the first few seconds after start.
      try {
        const BANNER_RE = />_\s*OpenAI Codex[\s\S]*?To get started, describe a task/i;
        if (BANNER_RE.test(data)) {
          const now = Date.now();
          // When descriptorPid is set we consider the session started.
          // Drop a second banner within the first 5s window.
          if ((descriptorPid != null) && (now - (startRef.current ?? now)) < 5000) {
            const first = data.replace(BANNER_RE, '');
            if (first.trim().length === 0) {
              return;
            }
            data = first;
          }
        }
      } catch {
        // best-effort trimming only
      }
      const anchoredToBottom = wasAtBottomRef.current || isScrolledToBottom(terminal);
      terminal.write(data);
      if (anchoredToBottom) {
        terminal.scrollToBottom();
        wasAtBottomRef.current = true;
      }
      terminal.forceRender?.();
      updateScrollTracking();
    },
    [descriptorPid, updateScrollTracking]
  );

  const syncInputState = useCallback(() => {
    const shouldEnable = status === 'running' && active && visible;
    terminalRef.current?.setStdinDisabled(!shouldEnable);
  }, [active, status, visible]);

  // No snapshot on mount. We rely on Codex resume to replay prior output.

  const setStatusWithSideEffects = useCallback(
    (next: TerminalLifecycle) => {
      setStatus(next);
      if (next === 'running') {
        errorRef.current = null;
      }
    },
    []
  );

  const ensureTerminalStarted = useCallback(async () => {
    if (status === 'running' || pendingStartRef.current) {
      return;
    }
    if (!resolvedWorktreeId) {
      onNotification('No linked worktree available to start Codex terminal.');
      return;
    }
    setStatusWithSideEffects('starting');
    const startupSessionId = session?.codexSessionId ?? latestSessionId;
    const startupCommand = buildResumeCommand(startupSessionId) ?? 'codex --yolo';
    startRef.current = Date.now();
    const startPromise = api
      .startWorktreeTerminal(resolvedWorktreeId, {
        startupCommand,
        paneId: paneIdRef.current
      })
      .then(async (descriptor) => {
        setDescriptorPid(descriptor.pid);
        setStatusWithSideEffects('running');
        setLastExit(null);
        bootstrappedRef.current = true;
        syncInputState();
        onBootstrapped?.();
        if (active && visibleRef.current) {
          terminalRef.current?.focus();
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to start Codex terminal';
        errorRef.current = message;
        onNotification(message);
        setStatusWithSideEffects('idle');
      })
      .finally(() => {
        pendingStartRef.current = null;
      });
    pendingStartRef.current = startPromise;
    await startPromise;
  }, [
    active,
    api,
    onBootstrapped,
    onNotification,
    latestSessionId,
    resolvedWorktreeId,
    session?.codexSessionId,
    setStatusWithSideEffects,
    status,
    syncInputState
  ]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    if (status === 'running') {
      syncInputState();
      return;
    }
    void ensureTerminalStarted();
  }, [ensureTerminalStarted, status, syncInputState, visible]);

  useEffect(() => {
    syncInputState();
  }, [syncInputState]);

  useEffect(() => {
    if (status === 'running' && !bootstrappedRef.current) {
      bootstrappedRef.current = true;
      onBootstrapped?.();
    }
  }, [onBootstrapped, status]);

  useEffect(() => {
    if (!resolvedWorktreeId) {
      return () => {
        // noop unsubscribe
      };
    }

    const unsubscribeOutput = api.onTerminalOutput((payload) => {
      if (payload.worktreeId !== resolvedWorktreeId) {
        return;
      }
      const currentPane = paneIdRef.current;
      if (currentPane !== undefined) {
        if (payload.paneId !== currentPane) {
          return;
        }
      } else if (payload.paneId !== undefined) {
        return;
      }
      writeChunk(payload.chunk);
    });

    const unsubscribeExit = api.onTerminalExit((payload) => {
      if (payload.worktreeId !== resolvedWorktreeId) {
        return;
      }
      setStatusWithSideEffects('exited');
      setDescriptorPid(null);
      setLastExit({ code: payload.exitCode, signal: payload.signal });
      pendingStartRef.current = null;
      bootstrappedRef.current = false;
      void api
        .refreshCodexSessionId(resolvedWorktreeId)
        .then((id) => {
          if (id) {
            setLatestSessionId(id);
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to refresh Codex session id';
          onNotification(message);
        });
      onUnbootstrapped?.();
    });

    return () => {
      unsubscribeOutput();
      unsubscribeExit();
    };
  }, [api, onNotification, onUnbootstrapped, resolvedWorktreeId, setStatusWithSideEffects, writeChunk]);

  useEffect(() => {
    if (active && visible && status === 'running') {
      terminalRef.current?.focus();
    }
  }, [active, status, visible]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (!visible) {
      handleTerminalScroll({
        position: terminal.getScrollPosition(),
        atBottom: isScrolledToBottom(terminal)
      });
      return;
    }
    restoreViewport();
  }, [handleTerminalScroll, restoreViewport, visible]);

  const handleTerminalData = useCallback(
    (data: string) => {
      if (!data || status !== 'running' || !active || !visible || !resolvedWorktreeId) {
        return;
      }
      onUserInput?.(data);
      api
        .sendTerminalInput(resolvedWorktreeId, data, { paneId: paneIdRef.current })
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to send Codex terminal input';
          errorRef.current = message;
          onNotification(message);
        });
    },
    [active, api, onNotification, onUserInput, resolvedWorktreeId, status, visible]
  );

  const handleResize = useCallback(
    ({ cols, rows }: { cols: number; rows: number }) => {
      if (!resolvedWorktreeId) {
        return;
      }
      api
        .resizeTerminal({ worktreeId: resolvedWorktreeId, cols, rows, paneId: paneIdRef.current })
        .catch((error) => {
          console.warn('[codex-terminal] failed to resize pty', error);
        });
    },
    [api, resolvedWorktreeId]
  );

  const attachTerminalRef = useCallback(
    (instance: CodexTerminalHandle | null) => {
      terminalRef.current = instance;
      if (instance) {
        if (!initialScrollRestoredRef.current && initialScrollState) {
          scrollPositionRef.current = initialScrollState.position;
          wasAtBottomRef.current = initialScrollState.atBottom;
          initialScrollRestoredRef.current = true;
          handleTerminalScroll({
            position: initialScrollState.position,
            atBottom: initialScrollState.atBottom
          });
        }
        syncInputState();
        if (!initialScrollState) {
          updateScrollTracking();
        }
      }
    },
    [handleTerminalScroll, initialScrollState, syncInputState, updateScrollTracking]
  );

  return (
    <section className={`terminal-pane terminal-pane--codex${visible ? '' : ' terminal-pane--inactive'}`}>
      {status !== 'running' ? (
        <div className="terminal-inline-actions">
          <button
            type="button"
            onClick={() => void ensureTerminalStarted()}
            disabled={status === 'starting' || codexUnavailable}
          >
            {status === 'starting' ? 'Starting…' : 'Start Codex Terminal'}
          </button>
        </div>
      ) : null}
      {codexUnavailable ? (
        <p className="terminal-hint">No linked worktree available for this tab.</p>
      ) : null}
      {lastExit ? (
        <p className="terminal-hint">
          Codex terminal exited (code {lastExit.code ?? 'null'}
          {lastExit.signal ? `, signal ${lastExit.signal}` : ''}).
        </p>
      ) : null}
      {errorRef.current ? <p className="terminal-error">{errorRef.current}</p> : null}
      <CodexTerminal
        key={`${worktree.id}:${paneId ?? 'default'}`}
        ref={attachTerminalRef}
        onData={handleTerminalData}
        instanceId={paneId ? `${worktree.id}-codex-terminal-${paneId}` : `${worktree.id}-codex-terminal`}
        onResize={handleResize}
        onScroll={handleTerminalScroll}
      />
      {descriptorPid ? (
        <footer className="terminal-footer">
          <div className="terminal-footer__details">
            <span>PID: {descriptorPid}</span>
            <span>Session ID: {displayedSessionId ?? '—'}</span>
            <span>Resume: {resumeCommandDisplay ?? 'Unavailable'}</span>
          </div>
          <button type="button" onClick={() => void openSessionPicker()} disabled={codexUnavailable}>
            Switch Session
          </button>
        </footer>
      ) : null}
      {sessionPickerOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={closeSessionPicker}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-terminal-session-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="codex-terminal-session-picker-title">Select Codex Session</h2>
            {sessionPickerLoading ? <p>Loading…</p> : null}
            {sessionPickerError ? <p className="modal-error">{sessionPickerError}</p> : null}
            {!sessionPickerLoading && !sessionPickerError ? (
              sessionChoices.length > 0 ? (
                <ul className="session-picker__list">
                  {sessionChoices.map((choice) => (
                    <li key={choice.id}>
                      <label>
                        <input
                          type="radio"
                          name="codex-terminal-session-choice"
                          value={choice.id}
                          checked={selectedSessionId === choice.id}
                          onChange={() => setSelectedSessionId(choice.id)}
                        />
                        {(() => {
                          const { title, abstract } = renderSessionSummary(choice.id, choice.preview);
                          return (
                            <div className="session-picker__tile">
                              <div className="session-picker__tile-header">
                                <span className="session-picker__title">
                                  {title} <span className="session-picker__id">({choice.id})</span>
                                </span>
                                <span className="session-picker__timestamp">
                                  {new Date(choice.mtimeMs).toLocaleString()}
                                </span>
                              </div>
                              <p className="session-picker__summary">
                                {sessionSummariesLoading[choice.id]
                                  ? 'Summarizing Codex activity…'
                                  : abstract || 'No recent Codex output.'}
                              </p>
                            </div>
                          );
                        })()}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No previous Codex sessions found for this worktree.</p>
              )
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                onClick={handleConfirmSession}
                disabled={sessionPickerLoading || (!sessionChoices.length && selectedSessionId == null)}
              >
                Use Selected Session
              </button>
              <button type="button" onClick={handleStartNewSession} disabled={sessionPickerLoading}>
                Start New Session
              </button>
              <button type="button" onClick={closeSessionPicker} disabled={sessionPickerLoading}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
};
