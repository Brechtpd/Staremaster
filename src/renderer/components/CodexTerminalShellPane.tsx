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
  shouldAutoStart?: boolean;
  onNotification(message: string | null): void;
  onUserInput?(data: string): void;
}

type TerminalLifecycle = 'idle' | 'starting' | 'running' | 'exited';

const CODEX_RESUME_REGEX = /codex resume --yolo [0-9a-fA-F-]+/i;
const ANSI_ESCAPE = '\u001b';
const ANSI_CSI_REGEX = new RegExp(`${ANSI_ESCAPE}\x5b[0-9;]*[A-Za-z]`, 'g');
const ANSI_OSC_LINK_REGEX = new RegExp(`${ANSI_ESCAPE}\x5d8;;.*?\u0007`, 'g');
const ANSI_OSC_TERMINATOR_REGEX = new RegExp(`${ANSI_ESCAPE}\\\\`, 'g');

const stripAnsiSequences = (input: string): string => {
  return input
    .replace(ANSI_OSC_LINK_REGEX, '')
    .replace(ANSI_OSC_TERMINATOR_REGEX, '')
    .replace(ANSI_CSI_REGEX, '');
};

const extractResumeCommand = (chunk: string): string | null => {
  const cleaned = stripAnsiSequences(chunk);
  const match = cleaned.match(CODEX_RESUME_REGEX);
  return match ? match[0] : null;
};

const buildCodexCommand = (session: DerivedCodexSession | undefined, fallback: string | null): string => {
  if (session?.codexSessionId) {
    return `codex resume --yolo ${session.codexSessionId}`;
  }
  if (fallback) {
    return fallback;
  }
  return 'codex --yolo';
};

export const CodexTerminalShellPane: React.FC<CodexTerminalShellPaneProps> = ({
  api,
  worktree,
  session,
  active,
  visible,
  paneId,
  shouldAutoStart = true,
  onNotification,
  onUserInput
}) => {
  const [descriptorPid, setDescriptorPid] = useState<number | null>(null);
  const [status, setStatus] = useState<TerminalLifecycle>('idle');
  const [lastExit, setLastExit] = useState<{ code: number | null; signal: string | null } | null>(null);
  const terminalRef = useRef<CodexTerminalHandle | null>(null);
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const pendingOutputRef = useRef('');
  const errorRef = useRef<string | null>(null);
  const hydratingRef = useRef(false);
  const scrollPositionRef = useRef(0);
  const visibleRef = useRef(visible);
  const shouldAutoStartRef = useRef(shouldAutoStart);
  const resumeCommandRef = useRef<string | null>(worktree.codexResumeCommand ?? null);
  const lastPersistedCommandRef = useRef<string | null>(worktree.codexResumeCommand ?? null);
  const paneIdRef = useRef<string | undefined>(paneId);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    shouldAutoStartRef.current = shouldAutoStart;
  }, [shouldAutoStart]);

  useEffect(() => {
    paneIdRef.current = paneId;
  }, [paneId]);

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
          const message = error instanceof Error
            ? error.message
            : 'Failed to refresh Codex resume command';
          onNotification(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, onNotification, worktree.codexResumeCommand, worktree.id]);

  const syncInputState = useCallback(() => {
    const shouldEnable = status === 'running' && active && visible;
    terminalRef.current?.setStdinDisabled(!shouldEnable);
  }, [active, status, visible]);

  const drainPendingOutput = useCallback(() => {
    if (!terminalRef.current || !pendingOutputRef.current) {
      return;
    }
    const chunk = pendingOutputRef.current;
    pendingOutputRef.current = '';
    terminalRef.current.write(chunk);
  }, []);

  const restoreViewport = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (scrollPositionRef.current > 0) {
      terminal.scrollToLine(scrollPositionRef.current);
    } else {
      terminal.scrollToBottom();
    }
  }, []);

  const hydrateVisibleTerminal = useCallback(() => {
    if (!visibleRef.current) {
      return;
    }
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    hydratingRef.current = true;
    terminal.refreshLayout();
    window.requestAnimationFrame(() => {
      const current = terminalRef.current;
      if (!current) {
        hydratingRef.current = false;
        return;
      }
      restoreViewport();
      drainPendingOutput();
      current.forceRender?.();
      hydratingRef.current = false;
      if (status === 'running' && active && visibleRef.current) {
        current.focus();
      }
    });
  }, [active, drainPendingOutput, restoreViewport, status]);

  const attachTerminalRef = useCallback((instance: CodexTerminalHandle | null) => {
    terminalRef.current = instance;
    if (instance) {
      syncInputState();
      if (visibleRef.current) {
        hydrateVisibleTerminal();
      }
    }
  }, [hydrateVisibleTerminal, syncInputState]);

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
    const startupCommand = buildCodexCommand(session, resumeCommandRef.current);
    const startPromise = api
      .startCodexTerminal(worktree.id, {
        startupCommand,
        paneId: paneIdRef.current,
        respondToCursorProbe: true
      })
      .then((descriptorResult) => {
        setDescriptorPid(descriptorResult.pid);
        setStatusWithSideEffects('running');
        setLastExit(null);
        pendingOutputRef.current = '';
        if (startupCommand.startsWith('codex resume --yolo')) {
          resumeCommandRef.current = startupCommand;
        }
        syncInputState();
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
  }, [active, api, onNotification, session, setStatusWithSideEffects, status, syncInputState, worktree.id]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    if (status === 'running') {
      syncInputState();
      return;
    }
    if (!shouldAutoStart) {
      return;
    }
    void ensureTerminalStarted();
  }, [ensureTerminalStarted, shouldAutoStart, status, syncInputState, visible]);

  useEffect(() => {
    syncInputState();
  }, [syncInputState]);

  useEffect(() => {
    const codexSessionId = session?.codexSessionId;
    if (!codexSessionId) {
      return;
    }
    const command = `codex resume --yolo ${codexSessionId}`;
    if (lastPersistedCommandRef.current === command) {
      resumeCommandRef.current = command;
      return;
    }
    resumeCommandRef.current = command;
    lastPersistedCommandRef.current = command;
    void api.setCodexResumeCommand(worktree.id, command).catch((error) => {
      const message = error instanceof Error ? error.message : 'Failed to persist Codex resume command';
      onNotification(message);
    });
  }, [api, onNotification, session?.codexSessionId, worktree.id]);

  useEffect(() => {
    const unsubscribeOutput = api.onCodexTerminalOutput((payload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      const command = extractResumeCommand(payload.chunk);
      if (command && command !== lastPersistedCommandRef.current) {
        resumeCommandRef.current = command;
        lastPersistedCommandRef.current = command;
        void api.setCodexResumeCommand(worktree.id, command).catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to persist Codex resume command';
          onNotification(message);
        });
      }
      if (!terminalRef.current || hydratingRef.current || !visibleRef.current) {
        pendingOutputRef.current += payload.chunk;
        return;
      }
      terminalRef.current.write(payload.chunk);
    });

    const unsubscribeExit = api.onCodexTerminalExit((payload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      setStatusWithSideEffects('exited');
      setLastExit({ code: payload.exitCode, signal: payload.signal });
      pendingStartRef.current = null;
      const exitCode = payload.exitCode ?? 0;
      const hadError = exitCode !== 0 || Boolean(payload.signal);
      if (hadError && lastPersistedCommandRef.current) {
        resumeCommandRef.current = null;
        lastPersistedCommandRef.current = null;
        void api
          .setCodexResumeCommand(worktree.id, null)
          .catch((error) => {
            const message = error instanceof Error ? error.message : 'Failed to clear Codex resume command';
            onNotification(message);
          })
          .finally(() => {
            void api.refreshCodexResumeCommand(worktree.id).then((refreshed) => {
              if (refreshed) {
                resumeCommandRef.current = refreshed;
                lastPersistedCommandRef.current = refreshed;
              }
              if (shouldAutoStartRef.current && visibleRef.current) {
                void ensureTerminalStarted();
              }
            });
          });
      }
    });

    return () => {
      unsubscribeOutput();
      unsubscribeExit();
    };
  }, [api, ensureTerminalStarted, onNotification, setStatusWithSideEffects, worktree.id]);

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
      return;
    }
    hydrateVisibleTerminal();
  }, [hydrateVisibleTerminal, visible]);

  const handleTerminalData = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      if (status !== 'running' || !active || !visible) {
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
