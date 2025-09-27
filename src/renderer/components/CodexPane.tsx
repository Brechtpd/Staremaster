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
  session: DerivedCodexSession | undefined;
  active: boolean;
  visible: boolean;
  paneId?: string;
  sessionWorktreeId: string;
  onNotification(message: string | null): void;
  onUserInput?(data: string): void;
  onBootstrapped?(): void;
  onUnbootstrapped?(): void;
}

const CODEX_RESUME_REGEX = /codex resume --yolo [0-9a-fA-F-]+/i;

const extractSessionIdFromCommand = (command?: string | null): string | null => {
  if (!command) {
    return null;
  }
  const match = CODEX_RESUME_REGEX.exec(command);
  if (!match) {
    return null;
  }
  const parts = match[0].trim().split(' ');
  return parts[parts.length - 1] ?? null;
};

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
  session,
  active,
  visible,
  paneId,
  sessionWorktreeId,
  onNotification,
  onUserInput,
  onBootstrapped
}) => {
  const terminalRef = useRef<CodexTerminalHandle | null>(null);
  const hydratorRef = useRef<Hydrator | null>(null);
  const hydratedSignatureRef = useRef<string | null>(null);
  const pendingInputsRef = useRef<string>('');
  const inflightInputRef = useRef<Promise<void> | null>(null);
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const lastStartAttemptRef = useRef<number>(0);
  const scrollPositionRef = useRef<number>(0);
  const cancelledRef = useRef(false);
  const bufferedOutputRef = useRef<string>('');
  const needsInitialRefreshRef = useRef<boolean>(true);
  const bootstrappedRef = useRef(false);
  const visibleRef = useRef(visible);
  const tryFlushInputsRef = useRef<() => void>(() => {});
  const startSessionRef = useRef<(
    options?: { throttled?: boolean; forceStart?: boolean }
  ) => Promise<void>>(async () => {});

  const status = session?.status ?? 'idle';
  const sessionSignature = session?.signature ?? 'none';
  const derivedError = session?.lastError;
  const hasCodexSessionId = Boolean(session?.codexSessionId);
  const resumeCommandDisplay = worktree.codexResumeCommand ?? null;
  const sessionIdDisplay = session?.codexSessionId ?? extractSessionIdFromCommand(resumeCommandDisplay);
  const [rescanBusy, setRescanBusy] = useState(false);

  useEffect(() => () => {
    cancelledRef.current = true;
    hydratorRef.current?.cancel();
    hydratorRef.current = null;
  }, []);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const tryFlushInputs = useCallback(() => {
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
      .sendCodexInput(sessionWorktreeId, payload)
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
  }, [api, onNotification, session?.status, sessionWorktreeId]);

  useEffect(() => {
    tryFlushInputsRef.current = tryFlushInputs;
  }, [tryFlushInputs]);

  const startSession = useCallback(
    async (options?: { throttled?: boolean; forceStart?: boolean }) => {
      if (!bridge) {
        console.log('[renderer] codex-pane start skipped (no bridge)', {
          worktreeId: worktree.id,
          sessionWorktreeId,
          paneId: paneId ?? 'default'
        });
        return;
      }
      const currentStatus: CodexUiStatus = session?.status ?? 'idle';
      if (!options?.forceStart) {
        if (!canAutoStart(currentStatus)) {
          console.log('[renderer] codex-pane start skipped (status)', {
            worktreeId: worktree.id,
            sessionWorktreeId,
            paneId: paneId ?? 'default',
            status: currentStatus,
            reason: 'canAutoStart=false'
          });
          return;
        }
        if (pendingStartRef.current) {
          console.log('[renderer] codex-pane start skipped (pending)', {
            worktreeId: worktree.id,
            sessionWorktreeId,
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
            sessionWorktreeId,
            paneId: paneId ?? 'default'
          });
          return;
        }
      }
      lastStartAttemptRef.current = Date.now();
      console.log('[renderer] codex-pane start', {
        worktreeId: worktree.id,
        sessionWorktreeId,
        paneId: paneId ?? 'default',
        options
      });
      onNotification(null);
      const startPromise = api.startCodex(sessionWorktreeId);
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
    [api, bridge, onNotification, paneId, session?.status, sessionWorktreeId, worktree.id]
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
    } else {
      bootstrappedRef.current = false;
    }
  }, [onBootstrapped, status]);

  useEffect(() => {
    if (!bridge) {
      return;
    }

    const unsubscribeOutput = bridge.onCodexOutput((payload) => {
      if (payload.worktreeId !== sessionWorktreeId) {
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
      if (payload.worktreeId !== sessionWorktreeId) {
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
  }, [bridge, onNotification, sessionWorktreeId, worktree.id]);

  useEffect(() => {
    if (!visible || !bridge) {
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
        const log = await bridge.getCodexLog(sessionWorktreeId);
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
    onNotification,
    session?.status,
    sessionSignature,
    visible,
    sessionWorktreeId,
    hasCodexSessionId,
    worktree.id
  ]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (!visible) {
      scrollPositionRef.current = terminal.getScrollPosition();
      terminal.setStdinDisabled(true);
      return;
    }
    if (bufferedOutputRef.current && !hydratorRef.current) {
      terminal.write(bufferedOutputRef.current);
      bufferedOutputRef.current = '';
    }
    needsInitialRefreshRef.current = false;
    if (scrollPositionRef.current > 0) {
      terminal.scrollToLine(scrollPositionRef.current);
    } else {
      terminal.scrollToBottom();
    }
    const interactive = isInteractiveStatus(status) && active;
    terminal.setStdinDisabled(!(interactive && visible));
    if (interactive && visible) {
      terminal.focus();
    }
    terminal.refreshLayout();
  }, [active, status, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    if (canAutoStart(status)) {
      console.log('[renderer] codex-pane auto-start', {
        worktreeId: worktree.id,
        sessionWorktreeId,
        paneId: paneId ?? 'default',
        status
      });
      void startSessionRef.current({ throttled: true });
    }
  }, [paneId, sessionWorktreeId, status, visible, worktree.id]);

  return (
    <section className={`terminal-pane${visible ? '' : ' terminal-pane--inactive'}`}>
      {derivedError ? <p className="terminal-error">{derivedError}</p> : null}
      <CodexTerminal
        ref={handleTerminalRef}
        onData={handleTerminalData}
        instanceId={paneId ? `${sessionWorktreeId}-codex-${paneId}` : `${sessionWorktreeId}-codex`}
      />
      {status !== 'running' ? (
        <p className="terminal-hint">
          {status === 'error'
            ? 'Codex session failed. Resolve the issue and retry.'
            : status === 'starting'
              ? 'Starting Codex…'
              : status === 'resuming'
                ? 'Resuming Codex…'
                : 'Codex session is not running.'}
        </p>
      ) : null}
      <footer className="terminal-footer">
        <span>Session ID: {sessionIdDisplay ?? '—'}</span>
        <span>Resume: {resumeCommandDisplay ?? 'Unavailable'}</span>
        <button
          type="button"
          onClick={async () => {
            setRescanBusy(true);
            try {
              await api.refreshCodexResumeFromLogs(sessionWorktreeId);
              await api.refreshCodexResumeCommand(sessionWorktreeId);
              if (sessionWorktreeId !== worktree.id) {
                await api.refreshCodexResumeCommand(worktree.id);
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Failed to rescan Codex resume command';
              onNotification(message);
            } finally {
              setRescanBusy(false);
            }
          }}
          disabled={rescanBusy}
        >
          {rescanBusy ? 'Rescanning…' : 'Rescan Resume'}
        </button>
      </footer>
    </section>
  );
};
