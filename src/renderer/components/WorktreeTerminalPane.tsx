import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RendererApi } from '@shared/api';
import type {
  WorktreeDescriptor,
  WorktreeTerminalDescriptor,
  TerminalOutputPayload,
  TerminalExitPayload,
  TerminalResizeRequest,
  TerminalSnapshot,
  TerminalDelta
} from '@shared/ipc';
import { CodexTerminal, type CodexTerminalHandle } from './CodexTerminal';

interface WorktreeTerminalPaneProps {
  api: RendererApi;
  worktree: WorktreeDescriptor;
  active: boolean;
  visible: boolean;
  paneId?: string;
  onNotification(message: string | null): void;
  onBootstrapped?(): void;
  initialScrollState?: { position: number; atBottom: boolean };
  onScrollStateChange?(state: { position: number; atBottom: boolean }): void;
}

type TerminalLifecycle = 'idle' | 'starting' | 'running' | 'exited';

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected terminal error';
};

const buildSnapshotOptions = (paneId?: string) => (paneId ? { paneId } : undefined);

export const WorktreeTerminalPane: React.FC<WorktreeTerminalPaneProps> = ({
  api,
  worktree,
  active,
  visible,
  paneId,
  onNotification,
  onBootstrapped,
  initialScrollState,
  onScrollStateChange
}) => {
  const [descriptor, setDescriptor] = useState<WorktreeTerminalDescriptor | null>(null);
  const [status, setStatus] = useState<TerminalLifecycle>('idle');
  const [lastExit, setLastExit] = useState<{ code: number | null; signal: string | null } | null>(null);

  const terminalRef = useRef<CodexTerminalHandle | null>(null);
  const paneIdRef = useRef<string | undefined>(paneId);
  const visibleRef = useRef<boolean>(visible);
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const hydratingRef = useRef(false);
  const pendingOutputRef = useRef('');
  const errorRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);
  const scrollPositionRef = useRef<number>(0);
  const wasAtBottomRef = useRef<boolean>(true);
  const initialScrollRestoredRef = useRef<boolean>(false);
  const scrollChangeCallbackRef = useRef<typeof onScrollStateChange>(onScrollStateChange);
  const lastEventIdRef = useRef<number>(0);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const needsSnapshotRef = useRef<boolean>(true);

  useEffect(() => {
    paneIdRef.current = paneId;
  }, [paneId]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

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

  const updateScrollTracking = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    wasAtBottomRef.current = terminal.isScrolledToBottom();
    scrollPositionRef.current = terminal.getScrollPosition();
    scrollChangeCallbackRef.current?.({ position: scrollPositionRef.current, atBottom: wasAtBottomRef.current });
  }, []);

  const writeToTerminal = useCallback(
    (chunk: string) => {
      if (!chunk) {
        return;
      }
      const terminal = terminalRef.current;
      if (!terminal || hydratingRef.current || !visibleRef.current) {
        pendingOutputRef.current += chunk;
        return;
      }
      const anchored = wasAtBottomRef.current || terminal.isScrolledToBottom();
      terminal.write(chunk);
      if (anchored) {
        terminal.scrollToBottom();
        wasAtBottomRef.current = true;
      }
      terminal.forceRender?.();
      updateScrollTracking();
    },
    [updateScrollTracking]
  );

  const drainPendingOutput = useCallback(() => {
    if (!pendingOutputRef.current) {
      return;
    }
    const buffered = pendingOutputRef.current;
    pendingOutputRef.current = '';
    writeToTerminal(buffered);
  }, [writeToTerminal]);

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

  const syncInputState = useCallback(() => {
    const shouldEnable = status === 'running' && active && visible;
    terminalRef.current?.setStdinDisabled(!shouldEnable);
  }, [active, status, visible]);

  const setStatusWithSideEffects = useCallback(
    (next: TerminalLifecycle) => {
      setStatus(next);
      if (next === 'running') {
        errorRef.current = null;
      }
    },
    []
  );

  const ensureTerminalStarted = useCallback(
    async (reason: string) => {
      if (status === 'running' || pendingStartRef.current) {
        return;
      }
      console.log('[renderer] worktree-terminal start', {
        worktreeId: worktree.id,
        paneId: paneIdRef.current ?? 'default',
        reason
      });
      setStatusWithSideEffects('starting');
      const startOptions = paneIdRef.current ? { paneId: paneIdRef.current } : undefined;
      const startPromise = (startOptions
        ? api.startWorktreeTerminal(worktree.id, startOptions)
        : api.startWorktreeTerminal(worktree.id))
        .then(async (descriptorResult) => {
          setDescriptor(descriptorResult);
          setStatusWithSideEffects('running');
          setLastExit(null);
          pendingOutputRef.current = '';
          lastEventIdRef.current = 0;
          wasAtBottomRef.current = true;
          syncInputState();
          onBootstrapped?.();
          await syncSnapshot(false);
          if (active && visibleRef.current) {
            terminalRef.current?.focus();
          }
        })
        .catch((error) => {
          const message = getErrorMessage(error);
          errorRef.current = message;
          onNotification(message);
          setStatusWithSideEffects('idle');
        })
        .finally(() => {
          pendingStartRef.current = null;
        });
      pendingStartRef.current = startPromise;
      await startPromise;
    },
    [active, api, onBootstrapped, onNotification, setStatusWithSideEffects, status, syncInputState, worktree.id]
  );

  const syncSnapshot = useCallback(
    async (preserveViewport: boolean) => {
      if (!terminalRef.current) {
        return;
      }
      try {
        const snapshot: TerminalSnapshot = await api.getTerminalSnapshot(
          worktree.id,
          buildSnapshotOptions(paneIdRef.current)
        );
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
        pendingOutputRef.current = '';
        needsSnapshotRef.current = false;
      } catch (error) {
        console.warn('[terminal] failed to load snapshot', error);
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
        const response: TerminalDelta = await api.getTerminalDelta(
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
          writeToTerminal(chunk.data);
          lastEventIdRef.current = chunk.id;
        }
        if (response.lastEventId > lastEventIdRef.current) {
          lastEventIdRef.current = response.lastEventId;
        }
        if (response.snapshot !== undefined || response.chunks.length > 0) {
          updateScrollTracking();
        }
      } catch (error) {
        console.warn('[terminal] failed to synchronise delta', error);
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
  }, [api, restoreViewport, updateScrollTracking, worktree.id, writeToTerminal]);

  useEffect(() => {
    void syncSnapshot(false);
  }, [syncSnapshot]);

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
    void ensureTerminalStarted('visible-effect');
  }, [ensureTerminalStarted, status, syncDelta, syncInputState, syncSnapshot, visible]);

  useEffect(() => {
    syncInputState();
  }, [syncInputState]);

  useEffect(() => {
    if (status === 'running' && !bootstrappedRef.current) {
      bootstrappedRef.current = true;
      onBootstrapped?.();
    } else if (status !== 'running') {
      bootstrappedRef.current = false;
    }
  }, [onBootstrapped, status]);

  useEffect(() => {
    const unsubscribeOutput = api.onTerminalOutput((payload: TerminalOutputPayload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      if (paneIdRef.current && payload.paneId && payload.paneId !== paneIdRef.current) {
        return;
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
      writeToTerminal(payload.chunk);
    });

    const unsubscribeExit = api.onTerminalExit((payload: TerminalExitPayload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      setStatusWithSideEffects('exited');
      setLastExit({ code: payload.exitCode, signal: payload.signal });
      pendingStartRef.current = null;
      pendingOutputRef.current = '';
      lastEventIdRef.current = 0;
    });

    return () => {
      unsubscribeOutput();
      unsubscribeExit();
    };
  }, [api, setStatusWithSideEffects, syncDelta, worktree.id, writeToTerminal]);

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
      wasAtBottomRef.current = terminal.isScrolledToBottom();
      scrollChangeCallbackRef.current?.({ position: scrollPositionRef.current, atBottom: wasAtBottomRef.current });
      return;
    }
    hydratingRef.current = true;
    terminal.refreshLayout();
    window.requestAnimationFrame(() => {
      hydratingRef.current = false;
      restoreViewport();
      drainPendingOutput();
      if (status === 'running' && active && visibleRef.current) {
        terminal.focus();
      }
    });
  }, [active, drainPendingOutput, restoreViewport, status, visible]);

  const handleTerminalData = useCallback(
    (data: string) => {
      if (!data || status !== 'running' || !active || !visible) {
        return;
      }
      const options = paneIdRef.current ? { paneId: paneIdRef.current } : undefined;
      const promise = options
        ? api.sendTerminalInput(worktree.id, data, options)
        : api.sendTerminalInput(worktree.id, data);
      promise.catch((error) => {
        const message = getErrorMessage(error);
        errorRef.current = message;
        onNotification(message);
      });
    },
    [active, api, onNotification, status, visible, worktree.id]
  );

  const handleResize = useCallback(
    ({ cols, rows }: { cols: number; rows: number }) => {
      const request: TerminalResizeRequest = {
        worktreeId: worktree.id,
        cols,
        rows,
        paneId: paneIdRef.current
      };

      api
        .resizeTerminal(request)
        .catch((error) => {
          console.warn('[terminal] failed to resize pty', error);
        });
    },
    [api, worktree.id]
  );

  return (
    <section className={`terminal-pane${visible ? '' : ' terminal-pane--inactive'}`}>
      {status !== 'running' ? (
        <div className="terminal-inline-actions">
          <button
            type="button"
            onClick={() => void ensureTerminalStarted('button')}
            disabled={status === 'starting'}
          >
            {status === 'starting' ? 'Starting…' : 'Start Terminal'}
          </button>
        </div>
      ) : null}
      {lastExit ? (
        <p className="terminal-hint">
          Terminal exited (code {lastExit.code ?? 'null'}{lastExit.signal ? `, signal ${lastExit.signal}` : ''}).
        </p>
      ) : null}
      {errorRef.current ? <p className="terminal-error">{errorRef.current}</p> : null}
      <CodexTerminal
        ref={(instance) => {
          terminalRef.current = instance;
          if (instance) {
            syncInputState();
            if (!initialScrollRestoredRef.current && initialScrollState) {
              scrollPositionRef.current = initialScrollState.position;
              wasAtBottomRef.current = initialScrollState.atBottom;
              initialScrollRestoredRef.current = true;
            }
            if (visibleRef.current) {
              restoreViewport();
              drainPendingOutput();
            } else {
              updateScrollTracking();
            }
          }
        }}
        onData={handleTerminalData}
        instanceId={paneId ? `${worktree.id}-terminal-${paneId}` : `${worktree.id}-terminal`}
        onResize={handleResize}
      />
      {descriptor ? (
        <footer className="terminal-footer">
          <span>Shell: {descriptor.shell}</span>
          {descriptor.pid > 0 ? <span>PID: {descriptor.pid}</span> : null}
        </footer>
      ) : null}
    </section>
  );
};
