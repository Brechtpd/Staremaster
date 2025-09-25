import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RendererApi } from '@shared/api';
import type {
  WorktreeDescriptor,
  WorktreeTerminalDescriptor,
  TerminalOutputPayload,
  TerminalExitPayload
} from '@shared/ipc';
import { CodexTerminal, type CodexTerminalHandle } from './CodexTerminal';

interface WorktreeTerminalPaneProps {
  api: RendererApi;
  worktree: WorktreeDescriptor;
  active: boolean;
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
  onNotification
}) => {
  const [descriptor, setDescriptor] = useState<WorktreeTerminalDescriptor | null>(null);
  const [status, setStatus] = useState<TerminalLifecycle>('idle');
  const [lastExit, setLastExit] = useState<{ code: number | null; signal: string | null } | null>(null);
  const terminalRef = useRef<CodexTerminalHandle | null>(null);
  const pendingStartRef = useRef<Promise<void> | null>(null);
  const pendingOutputRef = useRef('');
  const errorRef = useRef<string | null>(null);

  const updateStdinState = useCallback(
    (running: boolean) => {
      terminalRef.current?.setStdinDisabled(!running);
    },
    []
  );

  const flushPendingOutput = useCallback(() => {
    if (!terminalRef.current || !pendingOutputRef.current) {
      return;
    }
    terminalRef.current.write(pendingOutputRef.current);
    pendingOutputRef.current = '';
  }, []);

  const attachTerminalRef = useCallback((instance: CodexTerminalHandle | null) => {
    terminalRef.current = instance;
    if (instance) {
      updateStdinState(status === 'running');
      flushPendingOutput();
    }
  }, [flushPendingOutput, status, updateStdinState]);

  const setStatusWithSideEffects = useCallback(
    (next: TerminalLifecycle) => {
      setStatus(next);
      if (next === 'running') {
        errorRef.current = null;
      }
      updateStdinState(next === 'running');
    },
    [updateStdinState]
  );

  const ensureTerminalStarted = useCallback(async () => {
    if (status === 'running' || pendingStartRef.current) {
      return;
    }
    setStatusWithSideEffects('starting');
    const startPromise = api
      .startWorktreeTerminal(worktree.id)
      .then((descriptorResult) => {
        setDescriptor(descriptorResult);
        setStatusWithSideEffects('running');
        setLastExit(null);
        pendingOutputRef.current = '';
        terminalRef.current?.focus();
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
  }, [api, onNotification, setStatusWithSideEffects, status, worktree.id]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void ensureTerminalStarted();
  }, [active, ensureTerminalStarted]);

  useEffect(() => {
    const unsubscribeOutput = api.onTerminalOutput((payload: TerminalOutputPayload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      if (terminalRef.current) {
        terminalRef.current.write(payload.chunk);
      } else {
        pendingOutputRef.current += payload.chunk;
      }
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
    if (active && status === 'running') {
      terminalRef.current?.focus();
    }
  }, [active, status]);

  const handleTerminalData = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }
      if (status !== 'running') {
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
    [api, onNotification, status, worktree.id]
  );

  const handleResize = useCallback(
    ({ cols, rows }: { cols: number; rows: number }) => {
      api
        .resizeTerminal({ worktreeId: worktree.id, cols, rows })
        .catch((error) => {
          console.warn('[terminal] failed to resize pty', error);
        });
    },
    [api, worktree.id]
  );

  return (
    <section className={`terminal-pane${active ? '' : ' terminal-pane--inactive'}`}>
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
