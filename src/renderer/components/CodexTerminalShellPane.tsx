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
  sessionWorktreeId: string;
  onNotification(message: string | null): void;
  onUserInput?(data: string): void;
  onBootstrapped?(): void;
  onUnbootstrapped?(): void;
  initialScrollState?: { position: number; atBottom: boolean };
  onScrollStateChange?(state: { position: number; atBottom: boolean }): void;
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
  return match ? match[0] : null;
};

const SESSION_ID_FLAG_PREFIXES = ['--session', '--session-id', '--resume-id', '--yolo'];

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

const buildSnapshotOptions = (paneId?: string) => (paneId ? { paneId } : undefined);

export const CodexTerminalShellPane: React.FC<CodexTerminalShellPaneProps> = ({
  api,
  worktree,
  session,
  active,
  visible,
  paneId,
  sessionWorktreeId,
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
  const lastEventIdRef = useRef<number>(0);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const scrollPositionRef = useRef<number>(0);
  const wasAtBottomRef = useRef<boolean>(true);
  const errorRef = useRef<string | null>(null);
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const resumeCommandRef = useRef<string | null>(worktree.codexResumeCommand ?? null);
  const lastPersistedCommandRef = useRef<string | null>(worktree.codexResumeCommand ?? null);
  const initialScrollRestoredRef = useRef<boolean>(false);
  const scrollChangeCallbackRef = useRef<typeof onScrollStateChange>(onScrollStateChange);
  const needsSnapshotRef = useRef<boolean>(true);
  const [resumeCommandDisplay, setResumeCommandDisplay] = useState<string | null>(worktree.codexResumeCommand ?? null);
  const sessionIdDisplay = session?.codexSessionId ?? extractSessionIdFromCommand(resumeCommandDisplay);
  const [rescanBusy, setRescanBusy] = useState(false);

  useEffect(() => {
    scrollChangeCallbackRef.current = onScrollStateChange;
  }, [onScrollStateChange]);

  const persistResumeCommand = useCallback(
    (command: string | null) => {
      if (lastPersistedCommandRef.current === command) {
        return;
      }
      lastPersistedCommandRef.current = command;
      resumeCommandRef.current = command;
      const updates: Array<Promise<void>> = [api.setCodexResumeCommand(sessionWorktreeId, command)];
      if (sessionWorktreeId !== worktree.id) {
        updates.push(api.setCodexResumeCommand(worktree.id, command));
      }
      void Promise.all(updates).catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to persist Codex resume command';
        onNotification(message);
      });
      setResumeCommandDisplay(command);
    },
    [api, onNotification, sessionWorktreeId, worktree.id]
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
    if (typeof worktree.codexResumeCommand === 'string' && worktree.codexResumeCommand.length > 0) {
      resumeCommandRef.current = worktree.codexResumeCommand;
      lastPersistedCommandRef.current = worktree.codexResumeCommand;
      setResumeCommandDisplay(worktree.codexResumeCommand);
    }
  }, [worktree.codexResumeCommand]);

  useEffect(() => {
    let cancelled = false;
    api
      .refreshCodexResumeCommand(sessionWorktreeId)
      .then((command) => {
        if (cancelled) {
          return;
        }
        if (command) {
          persistResumeCommand(command);
          return;
        }
        const existing = worktree.codexResumeCommand ?? null;
        if (existing) {
          if (sessionWorktreeId !== worktree.id) {
            lastPersistedCommandRef.current = null;
            persistResumeCommand(existing);
          } else {
            resumeCommandRef.current = existing;
            lastPersistedCommandRef.current = existing;
            setResumeCommandDisplay(existing);
          }
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
    sessionWorktreeId,
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

  const updateScrollTracking = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    wasAtBottomRef.current = isScrolledToBottom(terminal);
    scrollPositionRef.current = terminal.getScrollPosition();
    scrollChangeCallbackRef.current?.({ position: scrollPositionRef.current, atBottom: wasAtBottomRef.current });
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
    const snapshot = await api.getCodexTerminalSnapshot(sessionWorktreeId, buildSnapshotOptions(paneIdRef.current));
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
        needsSnapshotRef.current = false;
      } catch (error) {
        console.warn('[codex-terminal] failed to load snapshot', error);
      }
    },
    [api, restoreViewport, sessionWorktreeId]
  );

  const syncDelta = useCallback(async () => {
    if (!terminalRef.current) {
      return;
    }
    const execute = async () => {
      try {
        const response = await api.getCodexTerminalDelta(
          sessionWorktreeId,
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
  }, [api, restoreViewport, sessionWorktreeId, updateScrollTracking, writeChunk]);

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
      .startCodexTerminal(sessionWorktreeId, {
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
  }, [active, api, onBootstrapped, onNotification, persistResumeCommand, session?.codexSessionId, sessionWorktreeId, setStatusWithSideEffects, status, syncInputState, syncSnapshot]);

  useEffect(() => {
    if (!visible) {
      needsSnapshotRef.current = true;
      return;
    }
    if (status === 'running') {
      syncInputState();
      const synchronise = async () => {
        if (needsSnapshotRef.current) {
          await syncSnapshot(true);
          needsSnapshotRef.current = false;
        }
        await syncDelta();
      };
      void synchronise();
      return;
    }
    void ensureTerminalStarted();
  }, [ensureTerminalStarted, status, syncDelta, syncInputState, syncSnapshot, visible]);

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
      if (payload.worktreeId !== sessionWorktreeId) {
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
      if (payload.worktreeId !== sessionWorktreeId) {
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
      needsSnapshotRef.current = true;
      scrollChangeCallbackRef.current?.({ position: scrollPositionRef.current, atBottom: wasAtBottomRef.current });
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
        .sendCodexTerminalInput(sessionWorktreeId, data, { paneId: paneIdRef.current })
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
        .resizeCodexTerminal({ worktreeId: sessionWorktreeId, cols, rows, paneId: paneIdRef.current })
        .catch((error) => {
          console.warn('[codex-terminal] failed to resize pty', error);
        });
    },
    [api, sessionWorktreeId]
  );

  const handleRescanResume = useCallback(async () => {
    setRescanBusy(true);
    try {
      await api.refreshCodexResumeFromLogs(sessionWorktreeId);
      const updated = await api.refreshCodexResumeCommand(sessionWorktreeId);
      resumeCommandRef.current = updated ?? null;
      lastPersistedCommandRef.current = updated ?? null;
      setResumeCommandDisplay(updated ?? null);
      if (sessionWorktreeId !== worktree.id) {
        await api.refreshCodexResumeCommand(worktree.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rescan Codex resume command';
      onNotification(message);
    } finally {
      setRescanBusy(false);
    }
  }, [api, onNotification, sessionWorktreeId, worktree.id]);

  const attachTerminalRef = useCallback(
    (instance: CodexTerminalHandle | null) => {
      terminalRef.current = instance;
      if (instance) {
        if (!initialScrollRestoredRef.current && initialScrollState) {
          scrollPositionRef.current = initialScrollState.position;
          wasAtBottomRef.current = initialScrollState.atBottom;
          initialScrollRestoredRef.current = true;
        }
        syncInputState();
        updateScrollTracking();
      }
    },
    [initialScrollState, syncInputState, updateScrollTracking]
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
