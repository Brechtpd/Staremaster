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
  onNotification(message: string | null): void;
  onUserInput?(data: string): void;
}

type TerminalLifecycle = 'idle' | 'starting' | 'running' | 'exited';

const buildCodexCommand = (session: DerivedCodexSession | undefined): string => {
  if (session?.codexSessionId) {
    return `codex resume --yolo ${session.codexSessionId}`;
  }
  return 'codex --yolo';
};

export const CodexTerminalShellPane: React.FC<CodexTerminalShellPaneProps> = ({
  api,
  worktree,
  session,
  active,
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
  const bootstrapTokenRef = useRef<string | null>(null);

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
      .startCodexTerminal(worktree.id)
      .then((descriptorResult) => {
        setDescriptorPid(descriptorResult.pid);
        setStatusWithSideEffects('running');
        setLastExit(null);
        pendingOutputRef.current = '';
        terminalRef.current?.focus();
        bootstrapTokenRef.current = descriptorResult.sessionId;
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
  }, [api, onNotification, setStatusWithSideEffects, status, worktree.id]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void ensureTerminalStarted();
  }, [active, ensureTerminalStarted]);

  useEffect(() => {
    const unsubscribeOutput = api.onCodexTerminalOutput((payload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      if (terminalRef.current) {
        terminalRef.current.write(payload.chunk);
      } else {
        pendingOutputRef.current += payload.chunk;
      }
    });

    const unsubscribeExit = api.onCodexTerminalExit((payload) => {
      if (payload.worktreeId !== worktree.id) {
        return;
      }
      setStatusWithSideEffects('exited');
      setLastExit({ code: payload.exitCode, signal: payload.signal });
      pendingStartRef.current = null;
      bootstrapTokenRef.current = null;
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
      onUserInput?.(data);
      api
        .sendCodexTerminalInput(worktree.id, data)
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to send Codex terminal input';
          errorRef.current = message;
          onNotification(message);
        });
    },
    [api, onNotification, onUserInput, status, worktree.id]
  );

  const handleResize = useCallback(
    ({ cols, rows }: { cols: number; rows: number }) => {
      api
        .resizeCodexTerminal({ worktreeId: worktree.id, cols, rows })
        .catch((error) => {
          console.warn('[codex-terminal] failed to resize pty', error);
        });
    },
    [api, worktree.id]
  );

  useEffect(() => {
    if (!bootstrapTokenRef.current || status !== 'running') {
      return;
    }

    const command = buildCodexCommand(session);
    api
      .sendCodexTerminalInput(worktree.id, `${command}\n`)
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to bootstrap Codex terminal';
        errorRef.current = message;
        onNotification(message);
      })
      .finally(() => {
        bootstrapTokenRef.current = null;
      });
  }, [api, onNotification, session, status, worktree.id]);

  return (
    <section className={`terminal-pane${active ? '' : ' terminal-pane--inactive'}`}>
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
        instanceId={`${worktree.id}-codex-terminal`}
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
