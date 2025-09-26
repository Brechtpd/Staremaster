import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RendererApi } from '@shared/api';
import type { WorktreeDescriptor } from '@shared/ipc';
import { CodexTerminal, type CodexTerminalHandle } from './CodexTerminal';
import type { DerivedCodexSession } from '../codex-model';

interface CodexTerminalShellPaneProps {
  api: RendererApi;
  worktree: WorktreeDescriptor;
  session: DerivedCodexSession | undefined;
  active: boolean;
  visible: boolean;
  paneId?: string;
  onNotification(message: string | null): void;
  onUserInput?(data: string): void;
  onBootstrapped?(): void;
  onUnbootstrapped?(): void;
}

type TerminalLifecycle = 'idle' | 'starting' | 'running' | 'exited';

const isScrolledToBottom = (terminal: CodexTerminalHandle | null): boolean => {
  if (!terminal) {
    return true;
  }
  const probe = terminal as unknown as { isScrolledToBottom?: () => boolean };
  return Boolean(probe.isScrolledToBottom?.());
};

const buildSnapshotOptions = (paneId?: string) => (paneId ? { paneId } : undefined);

export const CodexTerminalShellPane: React.FC<CodexTerminalShellPaneProps> = ({
  api,
  worktree,
  session,
  active,
  visible,
  paneId,
  onNotification,
  onUserInput,
  onBootstrapped,
  onUnbootstrapped
}) => {
  const [descriptorPid, setDescriptorPid] = useState<number | null>(null);
  const [status, setStatus] = useState<TerminalLifecycle>('idle');
  const [lastExit, setLastExit] = useState<{ code: number | null; signal: string | null } | null>(null);

  const terminalRef = useRef<CodexTerminalHandle | null>(null);
  const paneIdRef = useRef<string | undefined>(paneId);
  const visibleRef = useRef<boolean>(visible);
  const bootstrappedRef = useRef<boolean>(false);
  const lastEventIdRef = useRef<number>(0);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const scrollPositionRef = useRef<number>(0);
  const wasAtBottomRef = useRef<boolean>(true);
  const errorRef = useRef<string | null>(null);
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const resumeCommandRef = useRef<string | null>(worktree.codexResumeCommand ?? null);
  const lastPersistedCommandRef = useRef<string | null>(worktree.codexResumeCommand ?? null);

  const persistResumeCommand = useCallback(
    (command: string | null) => {
      if (lastPersistedCommandRef.current === command) {
        return;
      }
      lastPersistedCommandRef.current = command;
      resumeCommandRef.current = command;
      void api
        .setCodexResumeCommand(worktree.id, command)
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to persist Codex resume command';
          onNotification(message);
        });
    },
    [api, onNotification, worktree.id]
  );

  useEffect(() => {
    paneIdRef.current = paneId;
  }, [paneId]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    if (typeof worktree.codexResumeCommand === 'string' && worktree.codexResumeCommand.length > 0) {
      resumeCommandRef.current = worktree.codexResumeCommand;
      lastPersistedCommandRef.current = worktree.codexResumeCommand;
    }
  }, [worktree.codexResumeCommand]);

  useEffect(() => {
    let cancelled = false;
    api
      .refreshCodexResumeCommand(worktree.id)
      .then((command) => {
        if (cancelled) {
          return;
        }
        if (command) {
          resumeCommandRef.current = command;
          lastPersistedCommandRef.current = command;
        } else if (!worktree.codexResumeCommand) {
          resumeCommandRef.current = null;
          lastPersistedCommandRef.current = null;
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Failed to refresh Codex resume command';
          onNotification(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, onNotification, worktree.codexResumeCommand, worktree.id]);

  useEffect(() => {
    const codexSessionId = session?.codexSessionId;
    if (!codexSessionId) {
      return;
    }
    const command = `codex resume --yolo ${codexSessionId}`;
    persistResumeCommand(command);
  }, [persistResumeCommand, session?.codexSessionId]);

  const updateScrollTracking = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    wasAtBottomRef.current = isScrolledToBottom(terminal);
    scrollPositionRef.current = terminal.getScrollPosition();
  }, []);

  const restoreViewport = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (wasAtBottomRef.current) {
      terminal.scrollToBottom();
    } else {
      terminal.scrollToLine(scrollPositionRef.current);
    }
    terminal.forceRender?.();
    updateScrollTracking();
  }, [updateScrollTracking]);

  const writeChunk = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
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
    [updateScrollTracking]
  );

  const syncSnapshot = useCallback(
    async (preserveViewport: boolean) => {
      if (!terminalRef.current) {
        return;
      }
      try {
        const snapshot = await api.getCodexTerminalSnapshot(worktree.id, buildSnapshotOptions(paneIdRef.current));
        const terminal = terminalRef.current;
        if (!terminal) {
          return;
        }
        terminal.clear();
        if (snapshot.content) {
          terminal.write(snapshot.content);
        }
        lastEventIdRef.current = snapshot.lastEventId;
        if (!preserveViewport) {
          wasAtBottomRef.current = true;
          scrollPositionRef.current = terminal.getScrollPosition();
        }
        restoreViewport();
      } catch (error) {
        console.warn('[codex-terminal] failed to load snapshot', error);
      }
    },
    [api, restoreViewport, worktree.id]
  );

  const syncDelta = useCallback(async () => {
    if (!terminalRef.current) {
      return;
    }
    const execute = async () => {
      try {
        const response = await api.getCodexTerminalDelta(
          worktree.id,
          lastEventIdRef.current,
          buildSnapshotOptions(paneIdRef.current)
        );
        const terminal = terminalRef.current;
        if (!terminal) {
          return;
        }
        if (response.snapshot !== undefined) {
          terminal.clear();
          if (response.snapshot) {
            terminal.write(response.snapshot);
          }
          lastEventIdRef.current = response.lastEventId;
          restoreViewport();
        }
        for (const chunk of response.chunks) {
          if (chunk.id <= lastEventIdRef.current) {
            continue;
          }
          writeChunk(chunk.data);
          lastEventIdRef.current = chunk.id;
        }
        if (response.snapshot !== undefined || response.chunks.length > 0) {
          updateScrollTracking();
        }
        if (response.lastEventId > lastEventIdRef.current) {
          lastEventIdRef.current = response.lastEventId;
        }
      } catch (error) {
        console.warn('[codex-terminal] failed to synchronise delta', error);
      }
    };

    if (syncPromiseRef.current) {
      syncPromiseRef.current = syncPromiseRef.current.then(() => execute());
      return syncPromiseRef.current;
    }

    const promise = execute().finally(() => {
      syncPromiseRef.current = null;
    });
    syncPromiseRef.current = promise;
    return promise;
  }, [api, restoreViewport, updateScrollTracking, worktree.id, writeChunk]);

  const syncInputState = useCallback(() => {
    const shouldEnable = status === 'running' && active && visible;
    terminalRef.current?.setStdinDisabled(!shouldEnable);
  }, [active, status, visible]);

  useEffect(() => {
    void syncSnapshot(false);
  }, [syncSnapshot]);

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
    setStatusWithSideEffects('starting');
    const startupCommand = session?.codexSessionId
      ? `codex resume --yolo ${session.codexSessionId}`
      : resumeCommandRef.current ?? 'codex --yolo';
    if (startupCommand.startsWith('codex resume --yolo')) {
      persistResumeCommand(startupCommand);
    }
    const startPromise = api
      .startCodexTerminal(worktree.id, {
        startupCommand,
        paneId: paneIdRef.current,
        respondToCursorProbe: true
      })
      .then(async (descriptor) => {
        setDescriptorPid(descriptor.pid);
        setStatusWithSideEffects('running');
        setLastExit(null);
        bootstrappedRef.current = true;
        syncInputState();
        onBootstrapped?.();
        await syncSnapshot(false);
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
  }, [active, api, onBootstrapped, onNotification, persistResumeCommand, session?.codexSessionId, setStatusWithSideEffects, status, syncInputState, syncSnapshot, worktree.id]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    if (status === 'running') {
      syncInputState();
      void syncDelta();
      return;
    }
    void ensureTerminalStarted();
  }, [ensureTerminalStarted, status, syncDelta, syncInputState, visible]);

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
    const unsubscribeOutput = api.onCodexTerminalOutput((payload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      if (paneIdRef.current && payload.paneId && payload.paneId !== paneIdRef.current) {
        return;
      }
      const candidate = extractResumeCommand(payload.chunk);
      if (candidate && candidate !== lastPersistedCommandRef.current) {
        persistResumeCommand(candidate);
      }
      if (payload.eventId != null) {
        if (payload.eventId <= lastEventIdRef.current) {
          return;
        }
        if (payload.eventId > lastEventIdRef.current + 1) {
          void syncDelta();
          return;
        }
        lastEventIdRef.current = payload.eventId;
      }
      writeChunk(payload.chunk);
    });

    const unsubscribeExit = api.onCodexTerminalExit((payload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      setStatusWithSideEffects('exited');
      setDescriptorPid(null);
      setLastExit({ code: payload.exitCode, signal: payload.signal });
      pendingStartRef.current = null;
      bootstrappedRef.current = false;
      const hadError = (payload.exitCode ?? 0) !== 0 || Boolean(payload.signal);
      if (hadError && lastPersistedCommandRef.current) {
        persistResumeCommand(null);
        api
          .refreshCodexResumeCommand(worktree.id)
          .then((command) => {
            if (command) {
              persistResumeCommand(command);
            }
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : 'Failed to refresh Codex resume command';
            onNotification(message);
          });
      }
      onUnbootstrapped?.();
    });

    return () => {
      unsubscribeOutput();
      unsubscribeExit();
    };
  }, [api, onNotification, onUnbootstrapped, persistResumeCommand, setStatusWithSideEffects, syncDelta, worktree.id, writeChunk]);

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
      scrollPositionRef.current = terminal.getScrollPosition();
      wasAtBottomRef.current = isScrolledToBottom(terminal);
      return;
    }
    restoreViewport();
  }, [restoreViewport, visible]);

  const handleTerminalData = useCallback(
    (data: string) => {
      if (!data || status !== 'running' || !active || !visible) {
        return;
      }
      onUserInput?.(data);
      api
        .sendCodexTerminalInput(worktree.id, data, { paneId: paneIdRef.current })
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to send Codex terminal input';
          errorRef.current = message;
          onNotification(message);
        });
    },
    [active, api, onNotification, onUserInput, status, visible, worktree.id]
  );

  const handleResize = useCallback(
    ({ cols, rows }: { cols: number; rows: number }) => {
      api
        .resizeCodexTerminal({ worktreeId: worktree.id, cols, rows, paneId: paneIdRef.current })
        .catch((error) => {
          console.warn('[codex-terminal] failed to resize pty', error);
        });
    },
    [api, worktree.id]
  );

  const attachTerminalRef = useCallback(
    (instance: CodexTerminalHandle | null) => {
      terminalRef.current = instance;
      if (instance) {
        syncInputState();
        updateScrollTracking();
      }
    },
    [syncInputState, updateScrollTracking]
  );

  return (
    <section className={`terminal-pane terminal-pane--codex${visible ? '' : ' terminal-pane--inactive'}`}>
      {status !== 'running' ? (
        <div className="terminal-inline-actions">
          <button
            type="button"
            onClick={() => void ensureTerminalStarted()}
            disabled={status === 'starting'}
          >
            {status === 'starting' ? 'Starting…' : 'Start Codex Terminal'}
          </button>
        </div>
      ) : null}
      {lastExit ? (
        <p className="terminal-hint">
          Codex terminal exited (code {lastExit.code ?? 'null'}
          {lastExit.signal ? `, signal ${lastExit.signal}` : ''}).
        </p>
      ) : null}
      {errorRef.current ? <p className="terminal-error">{errorRef.current}</p> : null}
      <CodexTerminal
        ref={attachTerminalRef}
        onData={handleTerminalData}
        instanceId={paneId ? `${worktree.id}-codex-terminal-${paneId}` : `${worktree.id}-codex-terminal`}
        onResize={handleResize}
      />
      {descriptorPid ? (
        <footer className="terminal-footer">
          <span>PID: {descriptorPid}</span>
        </footer>
      ) : null}
    </section>
  );
};
const CODEX_RESUME_REGEX = /codex resume --yolo [0-9a-fA-F-]+/i;
const ANSI_ESCAPE = '\u001b';
const ANSI_CSI_REGEX = new RegExp(`${ANSI_ESCAPE}\x5b[0-9;]*[A-Za-z]`, 'g');
const ANSI_OSC_LINK_REGEX = new RegExp(`${ANSI_ESCAPE}\x5d8;;.*?\u0007`, 'g');
const ANSI_OSC_TERMINATOR_REGEX = new RegExp(`${ANSI_ESCAPE}\\\\`, 'g');

const stripAnsiSequences = (input: string): string =>
  input
    .replace(ANSI_OSC_LINK_REGEX, '')
    .replace(ANSI_OSC_TERMINATOR_REGEX, '')
    .replace(ANSI_CSI_REGEX, '');

const extractResumeCommand = (chunk: string): string | null => {
  const cleaned = stripAnsiSequences(chunk);
  const match = cleaned.match(CODEX_RESUME_REGEX);
  return match ? match[0] : null;
};
