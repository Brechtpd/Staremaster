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
  initialScrollState?: { position: number; atBottom: boolean };
  onScrollStateChange?(worktreeId: string, state: { position: number; atBottom: boolean }): void;
}

type TerminalLifecycle = 'idle' | 'starting' | 'running' | 'exited';

const CODEX_RESUME_REGEX = /codex resume --yolo (\S+)/i;
const ANSI_ESCAPE = '\u001b';
const ANSI_CSI_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const ANSI_OSC_LINK_REGEX = new RegExp(`${ANSI_ESCAPE}\\]8;;.*?\u0007`, 'g');
const ANSI_OSC_TERMINATOR_REGEX = new RegExp(`${ANSI_ESCAPE}\\\\`, 'g');

const stripControlCharacters = (value: string, replacement: string = ' '): string => {
  if (!value) {
    return '';
  }
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x20) {
      result += value[index];
    } else if (replacement) {
      result += replacement;
    }
  }
  return result;
};

const stripAnsiSequences = (input: string): string =>
  input
    .replace(ANSI_OSC_LINK_REGEX, '')
    .replace(ANSI_OSC_TERMINATOR_REGEX, '')
    .replace(ANSI_CSI_REGEX, '');

const extractResumeCommand = (chunk: string): string | null => {
  const cleaned = stripAnsiSequences(chunk);
  const match = cleaned.match(CODEX_RESUME_REGEX);
  return match ? `codex resume --yolo ${match[1]}` : null;
};

const SESSION_ID_FLAG_PREFIXES = ['--session', '--session-id', '--resume-id', '--yolo'];

const sanitizeResumeCommand = (command: string | null | undefined): string | null => {
  if (!command) {
    return null;
  }
  const trimmed = command.trim();
  if (!/^codex\s+resume\b/i.test(trimmed)) return null;
  const sessionId = extractSessionIdFromCommand(trimmed);
  return sessionId ? `codex resume --yolo ${sessionId}` : null;
};

const extractSessionIdFromCommand = (command?: string | null): string | null => {
  if (!command) {
    return null;
  }
  const sanitized = stripControlCharacters(stripAnsiSequences(command), ' ');
  const collapsed = sanitized.replace(/\s+/g, ' ').trim();
  if (!collapsed.toLowerCase().includes('codex resume')) {
    return null;
  }
  const tokens = collapsed.split(' ');
  let fallback: string | null = null;

  const stripTrailing = (value: string) => value.replace(/[.,;:]+$/, '');
  const isSessionFlag = (flag: string) => SESSION_ID_FLAG_PREFIXES.some((prefix) => flag.startsWith(prefix));

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
      if (equalsIndex !== -1 && equalsIndex < token.length - 1) {
        const value = stripTrailing(token.slice(equalsIndex + 1));
        if (isSessionFlag(flag) && value) {
          return value;
        }
        if (value) {
          fallback = value;
        }
        continue;
      }
      const next = tokens[index + 1];
      if (next && !next.startsWith('--')) {
        const value = stripTrailing(next);
        if (isSessionFlag(flag) && value) {
          return value;
        }
        if (value) {
          fallback = value;
        }
      }
      continue;
    }
    const value = stripTrailing(token);
    if (value && value.toLowerCase() !== 'codex' && value.toLowerCase() !== 'resume') {
      fallback = value;
    }
  }

  return fallback;
};

const isScrolledToBottom = (terminal: CodexTerminalHandle | null): boolean => {
  if (!terminal) {
    return true;
  }
  return terminal.isScrolledToBottom();
};

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
  const resumeCommandRef = useRef<string | null>(sanitizeResumeCommand(worktree.codexResumeCommand));
  const lastPersistedCommandRef = useRef<string | null>(sanitizeResumeCommand(worktree.codexResumeCommand));
  const initialScrollRestoredRef = useRef<boolean>(false);
  const scrollChangeCallbackRef = useRef<typeof onScrollStateChange>(onScrollStateChange);
  const [resumeCommandDisplay, setResumeCommandDisplay] = useState<string | null>(
    sanitizeResumeCommand(worktree.codexResumeCommand)
  );
  const sessionIdDisplay = session?.codexSessionId ?? extractSessionIdFromCommand(resumeCommandDisplay);
  const [rescanBusy, setRescanBusy] = useState(false);

  useEffect(() => {
    scrollChangeCallbackRef.current = onScrollStateChange;
  }, [onScrollStateChange]);

  const persistResumeCommand = useCallback(
    (command: string | null) => {
      const sanitized = sanitizeResumeCommand(command);
      if (lastPersistedCommandRef.current === sanitized) {
        return;
      }
      lastPersistedCommandRef.current = sanitized;
      resumeCommandRef.current = sanitized;
      const updates: Array<Promise<void>> = [api.setCodexResumeCommand(worktree.id, sanitized)];
      void Promise.all(updates).catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to persist Codex resume command';
        onNotification(message);
      });
      setResumeCommandDisplay(sanitized);
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
    const normalized = sanitizeResumeCommand(worktree.codexResumeCommand);
    if (normalized !== worktree.codexResumeCommand) {
      persistResumeCommand(normalized);
      return;
    }
    resumeCommandRef.current = normalized;
    lastPersistedCommandRef.current = normalized;
    setResumeCommandDisplay(normalized);
  }, [persistResumeCommand, worktree.codexResumeCommand]);

  useEffect(() => {
    let cancelled = false;
    api
      .refreshCodexResumeCommand(worktree.id)
      .then((command) => {
        if (cancelled) {
          return;
        }
        const normalized = sanitizeResumeCommand(command);
        if (normalized) {
          persistResumeCommand(normalized);
          return;
        }
        const existing = worktree.codexResumeCommand ?? null;
        if (existing) {
          lastPersistedCommandRef.current = null;
          persistResumeCommand(sanitizeResumeCommand(existing));
          return;
        }
        resumeCommandRef.current = null;
        lastPersistedCommandRef.current = null;
        setResumeCommandDisplay(null);
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
  }, [
    api,
    onNotification,
    persistResumeCommand,
    worktree.codexResumeCommand,
    worktree.id
  ]);

  useEffect(() => {
    const codexSessionId = session?.codexSessionId;
    if (!codexSessionId) {
      return;
    }
    const command = `codex resume --yolo ${codexSessionId}`;
    persistResumeCommand(command);
  }, [persistResumeCommand, session?.codexSessionId]);

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
    setStatusWithSideEffects('starting');
    const startupCommand = session?.codexSessionId
      ? `codex resume --yolo ${session.codexSessionId}`
      : resumeCommandRef.current ?? 'codex --yolo';
    if (startupCommand.startsWith('codex resume --yolo')) {
      persistResumeCommand(startupCommand);
    }
    startRef.current = Date.now();
    const startPromise = api
      .startWorktreeTerminal(worktree.id, {
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
  }, [active, api, onBootstrapped, onNotification, persistResumeCommand, session?.codexSessionId, setStatusWithSideEffects, status, syncInputState, worktree.id]);

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
    const unsubscribeOutput = api.onTerminalOutput((payload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      // Strict pane filtering
      const currentPane = paneIdRef.current;
      if (currentPane !== undefined) {
        if (payload.paneId !== currentPane) {
          return;
        }
      } else if (payload.paneId !== undefined) {
        return;
      }
      const chunk = payload.chunk;

      const candidate = extractResumeCommand(chunk);
      if (candidate && candidate !== lastPersistedCommandRef.current) {
        persistResumeCommand(candidate);
      }
      writeChunk(chunk);
    });

    const unsubscribeExit = api.onTerminalExit((payload) => {
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
  }, [api, onNotification, onUnbootstrapped, persistResumeCommand, setStatusWithSideEffects, worktree.id, writeChunk]);

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
      if (!data || status !== 'running' || !active || !visible) {
        return;
      }
      onUserInput?.(data);
    api
      .sendTerminalInput(worktree.id, data, { paneId: paneIdRef.current })
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
      .resizeTerminal({ worktreeId: worktree.id, cols, rows, paneId: paneIdRef.current })
        .catch((error) => {
          console.warn('[codex-terminal] failed to resize pty', error);
        });
    },
    [api, worktree.id]
  );

  const handleRescanResume = useCallback(async () => {
    setRescanBusy(true);
    try {
      await api.refreshCodexResumeFromLogs(worktree.id);
      const updated = sanitizeResumeCommand(await api.refreshCodexResumeCommand(worktree.id));
      resumeCommandRef.current = updated;
      lastPersistedCommandRef.current = updated;
      setResumeCommandDisplay(updated);
      if (updated !== worktree.codexResumeCommand) {
        persistResumeCommand(updated);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rescan Codex resume command';
      onNotification(message);
    } finally {
      setRescanBusy(false);
    }
  }, [api, onNotification, persistResumeCommand, worktree.codexResumeCommand, worktree.id]);

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
        key={`${worktree.id}:${paneId ?? 'default'}`}
        ref={attachTerminalRef}
        onData={handleTerminalData}
        instanceId={paneId ? `${worktree.id}-codex-terminal-${paneId}` : `${worktree.id}-codex-terminal`}
        onResize={handleResize}
        onScroll={handleTerminalScroll}
      />
      {descriptorPid ? (
        <footer className="terminal-footer">
          <span>PID: {descriptorPid}</span>
          <span>Session ID: {sessionIdDisplay ?? '—'}</span>
          <span>Resume: {resumeCommandDisplay ?? 'Unavailable'}</span>
          <button type="button" onClick={handleRescanResume} disabled={rescanBusy}>
            {rescanBusy ? 'Rescanning…' : 'Rescan Resume'}
          </button>
        </footer>
      ) : null}
    </section>
  );
};
