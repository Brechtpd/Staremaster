import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RendererApi } from '@shared/api';
import type {
  WorktreeDescriptor,
  WorktreeTerminalDescriptor,
  TerminalOutputPayload,
  TerminalExitPayload,
  TerminalResizeRequest
} from '@shared/ipc';
import { CodexTerminal, type CodexTerminalHandle } from './CodexTerminal';

interface WorktreeTerminalPaneProps {
  api: RendererApi;
  worktree: WorktreeDescriptor;
  active: boolean;
  visible: boolean;
  paneId?: string;
  onNotification(message: string | null): void;
}

type TerminalLifecycle = 'idle' | 'starting' | 'running' | 'exited';

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected terminal error';
};

export const WorktreeTerminalPane: React.FC<WorktreeTerminalPaneProps> = ({
  api,
  worktree,
  active,
  visible,
  paneId,
  onNotification
}) => {
  const [descriptor, setDescriptor] = useState<WorktreeTerminalDescriptor | null>(null);
  const [status, setStatus] = useState<TerminalLifecycle>('idle');
  const [lastExit, setLastExit] = useState<{ code: number | null; signal: string | null } | null>(null);
  const terminalRef = useRef<CodexTerminalHandle | null>(null);
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const pendingOutputRef = useRef('');
  const errorRef = useRef<string | null>(null);
  const paneIdRef = useRef<string | undefined>(paneId);
  const hydratingRef = useRef(false);
  const scrollPositionRef = useRef(0);
  const visibleRef = useRef(visible);

  useEffect(() => {
    paneIdRef.current = paneId;
  }, [paneId]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

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
    const startOptions = paneIdRef.current ? { paneId: paneIdRef.current } : undefined;
    const startPromise = (startOptions
      ? api.startWorktreeTerminal(worktree.id, startOptions)
      : api.startWorktreeTerminal(worktree.id))
      .then((descriptorResult) => {
        setDescriptor(descriptorResult);
        setStatusWithSideEffects('running');
        setLastExit(null);
        pendingOutputRef.current = '';
        syncInputState();
        if (active && visibleRef.current) {
          terminalRef.current?.focus();
        }
        terminalRef.current?.clear();
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
  }, [active, api, onNotification, setStatusWithSideEffects, status, syncInputState, worktree.id]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    void ensureTerminalStarted();
  }, [ensureTerminalStarted, visible]);

  useEffect(() => {
    syncInputState();
  }, [syncInputState]);

  useEffect(() => {
    const unsubscribeOutput = api.onTerminalOutput((payload: TerminalOutputPayload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      if (!terminalRef.current || hydratingRef.current || !visibleRef.current) {
        pendingOutputRef.current += payload.chunk;
        return;
      }
      terminalRef.current.write(payload.chunk);
    });

    const unsubscribeExit = api.onTerminalExit((payload: TerminalExitPayload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      setStatusWithSideEffects('exited');
      setLastExit({ code: payload.exitCode, signal: payload.signal });
      pendingStartRef.current = null;
    });

    return () => {
      unsubscribeOutput();
      unsubscribeExit();
    };
  }, [api, setStatusWithSideEffects, worktree.id]);

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
      if (paneIdRef.current) {
        api
          .sendTerminalInput(worktree.id, data, { paneId: paneIdRef.current })
          .catch((error) => {
            const message = getErrorMessage(error);
            errorRef.current = message;
            onNotification(message);
          });
        return;
      }

      api
        .sendTerminalInput(worktree.id, data)
        .catch((error) => {
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
        rows
      };
      if (paneIdRef.current) {
        request.paneId = paneIdRef.current;
      }

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
            onClick={() => void ensureTerminalStarted()}
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
        ref={attachTerminalRef}
        onData={handleTerminalData}
        instanceId={`${worktree.id}-terminal`}
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
