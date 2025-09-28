import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RendererApi } from '@shared/api';
import type { WorktreeDescriptor } from '@shared/ipc';
import {
  canAutoStart,
  DerivedCodexSession,
  isInteractiveStatus,
  CodexUiStatus
} from '../codex-model';
import { CodexTerminal, CodexTerminalHandle } from './CodexTerminal';

const MAX_HYDRATION_CHARS = 400_000;
const HYDRATION_CHUNK_SIZE = 4_096;
const START_THROTTLE_MS = 5_000;

interface IdleCallbackDeadline {
  didTimeout: boolean;
  timeRemaining(): number;
}

interface IdleCallbackWindow extends Window {
  requestIdleCallback?: (callback: (deadline: IdleCallbackDeadline) => void) => number;
  cancelIdleCallback?: (handle: number) => void;
}

interface Hydrator {
  cancel(): void;
}

interface CodexPaneProps {
  api: RendererApi;
  bridge: RendererApi | null;
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

const buildResumeCommand = (sessionId: string | null | undefined): string | null =>
  sessionId ? `codex resume --yolo ${sessionId}` : null;

const stripCodexLogAnnotations = (log: string): string => {
  const annotationPattern = /^\[[^\]]+]\s+Session\s+(started|exited|stopping\b).*$/;
  return log
    .split('\n')
    .filter((line) => !annotationPattern.test(line.trim()))
    .join('\n');
};

const startTerminalHydration = (
  terminal: CodexTerminalHandle,
  content: string,
  onComplete: () => void
): Hydrator | null => {
  if (!content) {
    onComplete();
    return null;
  }

  let cancelled = false;
  let index = 0;
  let timeoutId: number | null = null;
  let idleId: number | null = null;
  const idleWindow = window as IdleCallbackWindow;

  const cancel = () => {
    cancelled = true;
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (idleId !== null && idleWindow.cancelIdleCallback) {
      idleWindow.cancelIdleCallback(idleId);
      idleId = null;
    }
  };

  const schedule = () => {
    if (cancelled) {
      return;
    }
    if (idleWindow.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(run);
    } else {
      timeoutId = window.setTimeout(() => run(), 0);
    }
  };

  const run = (deadline?: IdleCallbackDeadline) => {
    idleId = null;
    timeoutId = null;
    if (cancelled) {
      return;
    }
    if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 1) {
      schedule();
      return;
    }

    const nextChunk = content.slice(index, index + HYDRATION_CHUNK_SIZE);
    index += HYDRATION_CHUNK_SIZE;
    if (nextChunk) {
      terminal.write(nextChunk);
    }
    if (index < content.length) {
      schedule();
    } else {
      onComplete();
    }
  };

  schedule();

  return {
    cancel
  };
};

const waitForTerminal = (resolver: () => CodexTerminalHandle | null, signal: { cancelled: boolean }): Promise<CodexTerminalHandle | null> => {
  return new Promise((resolve) => {
    const poll = () => {
      if (signal.cancelled) {
        resolve(null);
        return;
      }
      const terminal = resolver();
      if (terminal) {
        resolve(terminal);
        return;
      }
      window.requestAnimationFrame(poll);
    };
    poll();
  });
};

export const CodexPane: React.FC<CodexPaneProps> = ({
  api,
  bridge,
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
  const terminalRef = useRef<CodexTerminalHandle | null>(null);
  const hydratorRef = useRef<Hydrator | null>(null);
  const hydratedSignatureRef = useRef<string | null>(null);
  const pendingInputsRef = useRef<string>('');
  const inflightInputRef = useRef<Promise<void> | null>(null);
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const lastStartAttemptRef = useRef<number>(0);
  const scrollPositionRef = useRef<number>(0);
  const previousWorktreeIdRef = useRef<string>(worktree.id);
  const wasAtBottomRef = useRef<boolean>(true);
  const cancelledRef = useRef(false);
  const bufferedOutputRef = useRef<string>('');
  const needsInitialRefreshRef = useRef<boolean>(true);
  const bootstrappedRef = useRef(false);
  const visibleRef = useRef(visible);
  const tryFlushInputsRef = useRef<() => void>(() => {});
  const scrollChangeCallbackRef = useRef<typeof onScrollStateChange>(onScrollStateChange);
  const initialScrollRestoredRef = useRef<boolean>(false);
  const startSessionRef = useRef<(
    options?: { throttled?: boolean; forceStart?: boolean }
  ) => Promise<void>>(async () => {});

  const status = session?.status ?? 'idle';
  const sessionSignature = session?.signature ?? 'none';
  const derivedError = session?.lastError;
  const hasCodexSessionId = Boolean(session?.codexSessionId);
  const [latestSessionId, setLatestSessionId] = useState<string | null>(session?.codexSessionId ?? null);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionPickerLoading, setSessionPickerLoading] = useState(false);
  const [sessionPickerError, setSessionPickerError] = useState<string | null>(null);
  const [sessionChoices, setSessionChoices] = useState<Array<{ id: string; mtimeMs: number; preview: string }>>([]);
  const [sessionSummaries, setSessionSummaries] = useState<Record<string, string>>({});
  const [sessionSummariesLoading, setSessionSummariesLoading] = useState<Record<string, boolean>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const resolvedWorktreeId = sessionWorktreeId ?? (worktree.id.startsWith('project-root:') ? null : worktree.id);
  const codexUnavailable = resolvedWorktreeId == null;
  const autoPickerPromptedRef = useRef(false);
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

  useEffect(() => () => {
    cancelledRef.current = true;
    hydratorRef.current?.cancel();
    hydratorRef.current = null;
  }, []);

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
    scrollChangeCallbackRef.current = onScrollStateChange;
  }, [onScrollStateChange]);

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
    // Persist scroll state for the previous worktree before switching.
    const previousId = previousWorktreeIdRef.current;
    const terminal = terminalRef.current;
    if (terminal && scrollChangeCallbackRef.current && previousId !== worktree.id) {
      const position = terminal.getScrollPosition();
      const atBottom = typeof terminal.isScrolledToBottom === 'function'
        ? terminal.isScrolledToBottom()
        : true;
      scrollChangeCallbackRef.current(previousId, { position, atBottom });
    }
    previousWorktreeIdRef.current = worktree.id;
    // Reset per-worktree so the initial scroll state for the new worktree
    // is applied the first time it becomes visible.
    initialScrollRestoredRef.current = false;
    if (initialScrollState) {
      scrollPositionRef.current = initialScrollState.position;
      wasAtBottomRef.current = initialScrollState.atBottom;
      if (visibleRef.current) {
        requestAnimationFrame(() => {
          const t = terminalRef.current;
          if (!t) return;
          if (!wasAtBottomRef.current && scrollPositionRef.current > 0) {
            const current = t.getScrollPosition();
            const delta = scrollPositionRef.current - current;
            if (delta !== 0 && typeof t.scrollLines === 'function') {
              t.scrollLines(delta);
            } else {
              t.scrollToLine(scrollPositionRef.current);
            }
          } else {
            t.scrollToBottom();
          }
          t.forceRender?.();
        });
      }
    }
  }, [initialScrollState, worktree.id]);

  const tryFlushInputs = useCallback(() => {
    if (!resolvedWorktreeId) {
      return;
    }
    if (pendingInputsRef.current.length === 0) {
      return;
    }
    if (pendingStartRef.current) {
      return;
    }
    if (session?.status !== 'running') {
      return;
    }
    if (inflightInputRef.current) {
      return;
    }

    const payload = pendingInputsRef.current;
    pendingInputsRef.current = '';

    inflightInputRef.current = api
      .sendCodexInput(resolvedWorktreeId, payload)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Failed to send input to Codex';
        onNotification(message);
        pendingInputsRef.current = payload + pendingInputsRef.current;
        if (message.includes('No running Codex session')) {
          void startSessionRef.current({ forceStart: true });
        }
      })
      .finally(() => {
        inflightInputRef.current = null;
        if (pendingInputsRef.current) {
          tryFlushInputsRef.current();
        }
      });
  }, [api, onNotification, resolvedWorktreeId, session?.status]);

  useEffect(() => {
    tryFlushInputsRef.current = tryFlushInputs;
  }, [tryFlushInputs]);

  const startSession = useCallback(
    async (options?: { throttled?: boolean; forceStart?: boolean }) => {
      if (!bridge) {
        console.log('[renderer] codex-pane start skipped (no bridge)', {
          worktreeId: worktree.id,
          paneId: paneId ?? 'default'
        });
        return;
      }
      if (!resolvedWorktreeId) {
        console.log('[renderer] codex-pane start skipped (no canonical worktree)', {
          worktreeId: worktree.id,
          paneId: paneId ?? 'default'
        });
        if (!options?.forceStart) {
          onNotification('No linked worktree available for this project. Create or select a worktree to run Codex.');
        }
        return;
      }
      const currentStatus: CodexUiStatus = session?.status ?? 'idle';
      if (!options?.forceStart) {
        if (!canAutoStart(currentStatus)) {
          console.log('[renderer] codex-pane start skipped (status)', {
            worktreeId: worktree.id,
            paneId: paneId ?? 'default',
            status: currentStatus,
            reason: 'canAutoStart=false'
          });
          return;
        }
        if (pendingStartRef.current) {
          console.log('[renderer] codex-pane start skipped (pending)', {
            worktreeId: worktree.id,
            paneId: paneId ?? 'default'
          });
          return;
        }
      }
      if (options?.throttled && !options?.forceStart) {
        const lastAttempt = lastStartAttemptRef.current;
        if (Date.now() - lastAttempt < START_THROTTLE_MS) {
          console.log('[renderer] codex-pane start skipped (throttled)', {
            worktreeId: worktree.id,
            paneId: paneId ?? 'default'
          });
          return;
        }
      }
      lastStartAttemptRef.current = Date.now();
      console.log('[renderer] codex-pane start', {
        worktreeId: resolvedWorktreeId,
        paneId: paneId ?? 'default',
        options
      });
      onNotification(null);
      const startPromise = api.startCodex(resolvedWorktreeId);
      pendingStartRef.current = startPromise;
      try {
        await startPromise;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to start Codex session';
        onNotification(message);
      } finally {
        pendingStartRef.current = null;
        tryFlushInputsRef.current();
      }
    },
    [
      api,
      bridge,
      onNotification,
      paneId,
      resolvedWorktreeId,
      session?.status,
      worktree.id
    ]
  );

  useEffect(() => {
    startSessionRef.current = startSession;
  }, [startSession]);

  const handleTerminalRef = useCallback(
    (instance: CodexTerminalHandle | null) => {
      terminalRef.current = instance;
      if (!instance) {
        return;
      }
      const interactive = isInteractiveStatus(status) && active && visibleRef.current;
      instance.setStdinDisabled(!interactive);
      if (interactive) {
        instance.focus();
      }
      if (bufferedOutputRef.current && visibleRef.current) {
        instance.write(bufferedOutputRef.current);
        bufferedOutputRef.current = '';
      }
    },
    [active, status]
  );

  const handleTerminalData = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      if (!active || !visible) {
        return;
      }
      onUserInput?.(data);
      pendingInputsRef.current += data;
      if (session?.status === 'running' && !pendingStartRef.current) {
        tryFlushInputsRef.current();
      } else if (session?.status !== 'running') {
        void startSessionRef.current({ throttled: true });
      }
    },
    [active, onUserInput, session?.status, visible]
  );

  useEffect(() => {
    if (session?.status === 'running') {
      tryFlushInputsRef.current();
    }
  }, [session?.status]);

  useEffect(() => {
    if (status === 'running') {
      if (!bootstrappedRef.current) {
        bootstrappedRef.current = true;
        onBootstrapped?.();
      }
    } else if (bootstrappedRef.current) {
      bootstrappedRef.current = false;
      onUnbootstrapped?.();
    }
  }, [onBootstrapped, onUnbootstrapped, status]);

  useEffect(() => {
    if (!bridge || !resolvedWorktreeId) {
      return;
    }

    const unsubscribeOutput = bridge.onCodexOutput((payload) => {
      if (payload.worktreeId !== resolvedWorktreeId) {
        return;
      }
      const terminal = terminalRef.current;
      if (!terminal || hydratorRef.current || !visibleRef.current) {
        bufferedOutputRef.current += payload.chunk;
        return;
      }
      if (needsInitialRefreshRef.current) {
        terminal.refreshLayout();
        needsInitialRefreshRef.current = false;
      }
      terminal.write(payload.chunk);
    });

    const unsubscribeStatus = bridge.onCodexStatus((payload) => {
      if (payload.worktreeId !== resolvedWorktreeId) {
        return;
      }
      if (payload.status === 'error' && payload.error) {
        onNotification(payload.error);
      }
      if (payload.status === 'running') {
        tryFlushInputsRef.current();
      }
    });

    return () => {
      unsubscribeOutput();
      unsubscribeStatus();
    };
  }, [bridge, onNotification, resolvedWorktreeId]);

  useEffect(() => {
    if (!visible || !bridge || !resolvedWorktreeId) {
      return;
    }

    let cancelled = false;

    const hydrate = async () => {
      const terminal = await waitForTerminal(() => terminalRef.current, { cancelled });
      if (!terminal || cancelled) {
        return;
      }

      const signatureChanged = hydratedSignatureRef.current !== sessionSignature;
      if (!signatureChanged) {
        if (bufferedOutputRef.current) {
          terminal.write(bufferedOutputRef.current);
          bufferedOutputRef.current = '';
        }
        needsInitialRefreshRef.current = false;
        terminal.refreshLayout();
        if (session?.status === 'running') {
          tryFlushInputsRef.current();
        }
        return;
      }

      const shouldHydrateFromLog = !hasCodexSessionId;
      if (!shouldHydrateFromLog) {
        terminal.clear();
        hydratedSignatureRef.current = sessionSignature;
        if (bufferedOutputRef.current) {
          terminal.write(bufferedOutputRef.current);
          bufferedOutputRef.current = '';
        }
        terminal.write('\u001b[6n');
        needsInitialRefreshRef.current = false;
        if (session?.status === 'running') {
          tryFlushInputsRef.current();
        }
        terminal.refreshLayout();
        return;
      }

      hydratorRef.current?.cancel();
      hydratorRef.current = null;
      terminal.clear();

      let content = '';
      try {
        const log = await bridge.getCodexLog(resolvedWorktreeId);
        if (cancelled) {
          return;
        }
        content = log ? stripCodexLogAnnotations(log) : '';
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Failed to load Codex log';
          onNotification(message);
        }
        return;
      }

      content = content.length <= MAX_HYDRATION_CHARS
        ? content
        : content.slice(-MAX_HYDRATION_CHARS);

      const finalizeHydration = () => {
        if (cancelled) {
          return;
        }
        hydratedSignatureRef.current = sessionSignature;
        if (session?.status === 'running') {
          tryFlushInputsRef.current();
        }
        needsInitialRefreshRef.current = false;
        terminal.scrollToBottom();
        terminal.refreshLayout();
      };

      const hydrator = startTerminalHydration(terminal, content, () => {
        finalizeHydration();
        hydratorRef.current = null;
      });

      if (!hydrator) {
        finalizeHydration();
      } else {
        hydratorRef.current = hydrator;
      }
    };

    hydrate().catch((error: unknown) => {
      if (!cancelled) {
        const message = error instanceof Error ? error.message : 'Failed to load Codex log';
        onNotification(message);
      }
    });

    return () => {
      cancelled = true;
      hydratorRef.current?.cancel();
      hydratorRef.current = null;
    };
  }, [
    bridge,
    hasCodexSessionId,
    onNotification,
    resolvedWorktreeId,
    session?.status,
    sessionSignature,
    visible
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (!visible) {
      scrollPositionRef.current = terminal.getScrollPosition();
      try {
        // @ts-expect-error optional API
        wasAtBottomRef.current = typeof terminal.isScrolledToBottom === 'function'
          ? terminal.isScrolledToBottom()
          : wasAtBottomRef.current;
      } catch {
        // ignore
      }
      const cb = scrollChangeCallbackRef.current;
      if (cb) {
        cb(worktree.id, { position: scrollPositionRef.current, atBottom: wasAtBottomRef.current });
      }
      terminal.setStdinDisabled(true);
      return;
    }
    if (bufferedOutputRef.current && !hydratorRef.current) {
      terminal.write(bufferedOutputRef.current);
      bufferedOutputRef.current = '';
    }
    needsInitialRefreshRef.current = false;
    if (!wasAtBottomRef.current && scrollPositionRef.current > 0) {
      const current = terminal.getScrollPosition();
      const delta = scrollPositionRef.current - current;
      if (delta !== 0 && typeof terminal.scrollLines === 'function') {
        terminal.scrollLines(delta);
      } else {
        terminal.scrollToLine(scrollPositionRef.current);
      }
    } else {
      terminal.scrollToBottom();
      wasAtBottomRef.current = true;
    }
    const interactive = isInteractiveStatus(status) && active;
    terminal.setStdinDisabled(!(interactive && visible));
    if (interactive && visible) {
      terminal.focus();
    }
    terminal.refreshLayout();
    const cb = scrollChangeCallbackRef.current;
    if (cb) {
      cb(worktree.id, { position: terminal.getScrollPosition(), atBottom: wasAtBottomRef.current });
    }
  }, [active, status, visible, worktree.id]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    if (canAutoStart(status) && resolvedWorktreeId) {
      console.log('[renderer] codex-pane auto-start', {
        worktreeId: resolvedWorktreeId,
        paneId: paneId ?? 'default',
        status
      });
      void startSessionRef.current({ throttled: true });
    }
  }, [paneId, resolvedWorktreeId, status, visible, worktree.id]);

  useEffect(() => {
    if (!sessionPickerOpen || !resolvedWorktreeId) {
      return;
    }
    const summarizer = api.summarizeCodexOutput;
    sessionChoices.forEach((choice) => {
      if (sessionSummaries[choice.id] || sessionSummariesLoading[choice.id]) {
        return;
      }
      if (!choice.preview.trim()) {
        setSessionSummaries((prev) => ({ ...prev, [choice.id]: 'No recent Codex output.' }));
        return;
      }
      if (!summarizer) {
        setSessionSummaries((prev) => ({ ...prev, [choice.id]: choice.preview.trim() }));
        return;
      }
      setSessionSummariesLoading((prev) => ({ ...prev, [choice.id]: true }));
      void Promise.resolve(summarizer(resolvedWorktreeId, choice.preview))
        .then((summary) => {
          setSessionSummaries((prev) => ({ ...prev, [choice.id]: summary?.trim() || choice.preview.trim() }));
        })
        .catch(() => {
          setSessionSummaries((prev) => ({ ...prev, [choice.id]: choice.preview.trim() }));
        })
        .finally(() => {
          setSessionSummariesLoading((prev) => {
            const next = { ...prev };
            delete next[choice.id];
            return next;
          });
        });
    });
  }, [api.summarizeCodexOutput, resolvedWorktreeId, sessionChoices, sessionPickerOpen, sessionSummaries, sessionSummariesLoading]);

  return (
    <section className={`terminal-pane${visible ? '' : ' terminal-pane--inactive'}`}>
      {derivedError ? <p className="terminal-error">{derivedError}</p> : null}
      <CodexTerminal
        ref={handleTerminalRef}
        onData={handleTerminalData}
        instanceId={paneId ? `${worktree.id}-codex-${paneId}` : `${worktree.id}-codex`}
      />
      {status !== 'running' ? (
        <p className="terminal-hint">
          {codexUnavailable
            ? 'No worktree available for this project tab.'
            : status === 'error'
              ? 'Codex session failed. Resolve the issue and retry.'
              : status === 'starting'
                ? 'Starting Codex…'
                : status === 'resuming'
                  ? 'Resuming Codex…'
                  : 'Codex session is not running.'}
        </p>
      ) : null}
      <footer className="terminal-footer">
        <div className="terminal-footer__details">
          <span>Session ID: {displayedSessionId ?? '—'}</span>
          <span>Resume: {resumeCommandDisplay ?? 'Unavailable'}</span>
        </div>
        <button type="button" onClick={() => void openSessionPicker()} disabled={codexUnavailable}>
          Switch Session
        </button>
      </footer>
      {sessionPickerOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={closeSessionPicker}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-session-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="codex-session-picker-title">Select Codex Session</h2>
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
                          name="codex-session-choice"
                          value={choice.id}
                          checked={selectedSessionId === choice.id}
                          onChange={() => setSelectedSessionId(choice.id)}
                        />
                        <div className="session-picker__tile">
                          <div className="session-picker__tile-header">
                            <span className="session-picker__id">{choice.id}</span>
                            <span className="session-picker__timestamp">
                              {new Date(choice.mtimeMs).toLocaleString()}
                            </span>
                          </div>
                          <p className="session-picker__summary">
                            {sessionSummariesLoading[choice.id]
                              ? 'Summarizing Codex activity…'
                              : (() => {
                                  const previewText = choice.preview.trim();
                                  const resolved = sessionSummaries[choice.id] ?? (previewText || 'No recent Codex output.');
                                  return resolved;
                                })()}
                          </p>
                        </div>
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
