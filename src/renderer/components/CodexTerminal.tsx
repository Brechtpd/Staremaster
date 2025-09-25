import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Terminal, type IDisposable } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

interface TerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  dataDisposable: IDisposable | null;
  refCount: number;
  stdinDisabled: boolean;
}

const terminalRegistry = new Map<string, TerminalEntry>();

export interface CodexTerminalHandle {
  write(data: string): void;
  clear(): void;
  focus(): void;
  setStdinDisabled(disabled: boolean): void;
  refreshLayout(): void;
  getScrollPosition(): number;
  scrollToLine(line: number): void;
  scrollToBottom(): void;
}

interface CodexTerminalProps {
  onData(data: string): void;
  instanceId: string;
}

export const CodexTerminal = React.forwardRef<CodexTerminalHandle, CodexTerminalProps>(
  ({ onData, instanceId }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const dataHandlerRef = useRef(onData);
    const themeRef = useRef({
      background: '#0f172a',
      foreground: '#f8fafc'
    });
    const pendingRef = useRef<string[]>([]);
    const readyRef = useRef(false);

    const retryTokenRef = useRef<number | null>(null);

    const getActiveBuffer = useCallback(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return null;
      }
      return (terminal as unknown as {
        buffer?: {
          active?: {
            ydisp: number;
          };
        };
      }).buffer?.active ?? null;
    }, []);

    const flushPending = useCallback(() => {
      if (!readyRef.current || !terminalRef.current) {
        return;
      }
      if (pendingRef.current.length === 0) {
        return;
      }
      const buffered = pendingRef.current.join('');
      pendingRef.current = [];
      terminalRef.current.write(buffered);
    }, []);

    const safeFit = useCallback(() => {
      const clearRetry = () => {
        if (retryTokenRef.current !== null) {
          window.clearTimeout(retryTokenRef.current);
          retryTokenRef.current = null;
        }
      };
      const fitAddon = fitAddonRef.current;
      const terminal = terminalRef.current;
      const container = containerRef.current;
      if (!fitAddon || !terminal || !container) {
        return;
      }
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        clearRetry();
        retryTokenRef.current = window.setTimeout(safeFit, 32);
        return;
      }
      try {
        const core = (terminal as unknown as {
          _core?: {
            _renderService?: {
              dimensions?: unknown;
            };
          };
        })._core;
        if (!core || !core._renderService || !core._renderService.dimensions) {
          clearRetry();
          retryTokenRef.current = window.setTimeout(safeFit, 32);
          return;
        }
        fitAddon.fit();
        clearRetry();
        if (!readyRef.current) {
          readyRef.current = true;
          flushPending();
        }
      } catch (error) {
        console.warn('[terminal] fit failed', error);
        clearRetry();
        retryTokenRef.current = window.setTimeout(safeFit, 32);
      }
    }, [flushPending]);

    useEffect(() => {
      dataHandlerRef.current = onData;
    }, [onData]);

    useLayoutEffect(() => {
      const container = containerRef.current;
      if (!container) {
        return undefined;
      }

      let entry = terminalRegistry.get(instanceId);
      if (!entry) {
        const terminalInstance = new Terminal({
          convertEol: true,
          cursorBlink: true,
          scrollback: 5000,
          fontFamily:
            "'Fira Code', 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: 14,
          cols: 80,
          rows: 24
        });
        const fitAddon = new FitAddon();
        terminalInstance.loadAddon(fitAddon);
        entry = {
          terminal: terminalInstance,
          fitAddon,
          dataDisposable: null,
          refCount: 0,
          stdinDisabled: false
        };
        terminalRegistry.set(instanceId, entry);
      }

      entry.refCount += 1;
      const terminalInstance = entry.terminal;
      const fitAddon = entry.fitAddon;
      terminalInstance.options.theme = themeRef.current;
      terminalInstance.options.disableStdin = entry.stdinDisabled;
      terminalRef.current = terminalInstance;
      fitAddonRef.current = fitAddon;
      readyRef.current = false;
      pendingRef.current = [];

      entry.dataDisposable?.dispose();
      entry.dataDisposable = terminalInstance.onData((data) => {
        dataHandlerRef.current(data);
      });

      let disposed = false;
      let rafId: number | null = null;
      const ensureOpen = () => {
        if (disposed) {
          return;
        }
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          rafId = window.requestAnimationFrame(ensureOpen);
          return;
        }
        terminalInstance.open(container);
        window.requestAnimationFrame(() => {
          safeFit();
          if (!readyRef.current) {
            readyRef.current = true;
            flushPending();
          }
          terminalInstance.focus();
        });
      };
      rafId = window.requestAnimationFrame(ensureOpen);

      let observer: ResizeObserver | null = null;
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => {
          window.requestAnimationFrame(() => {
            safeFit();
          });
        });
        observer.observe(container);
      }

      return () => {
        disposed = true;
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
        }
        observer?.disconnect();
        entry?.dataDisposable?.dispose();
        entry.dataDisposable = null;
        if (entry) {
          entry.refCount = Math.max(0, entry.refCount - 1);
          if (entry.refCount === 0) {
            entry.terminal.dispose();
            terminalRegistry.delete(instanceId);
          }
        }
        terminalRef.current = null;
        fitAddonRef.current = null;
        readyRef.current = false;
        if (retryTokenRef.current !== null) {
          window.clearTimeout(retryTokenRef.current);
          retryTokenRef.current = null;
        }
      };
    }, [flushPending, safeFit, instanceId]);

    useImperativeHandle(
      ref,
      () => ({
        write(data: string) {
          if (!data) {
            return;
          }
          if (!readyRef.current || !terminalRef.current) {
            pendingRef.current.push(data);
            return;
          }
          terminalRef.current.write(data);
        },
        clear() {
          const terminal = terminalRef.current;
          if (!terminal) {
            return;
          }
          const resetSequence = '\u001b[2J\u001b[3J\u001b[H';
          if (!readyRef.current) {
            pendingRef.current.push(resetSequence);
            return;
          }
          terminal.write(resetSequence);
          terminal.scrollToTop();
          safeFit();
        },
        focus() {
          terminalRef.current?.focus();
        },
        setStdinDisabled(disabled: boolean) {
          const terminal = terminalRef.current;
          if (!terminal) {
            return;
          }
          terminal.options.disableStdin = disabled;
          const entry = terminalRegistry.get(instanceId);
          if (entry) {
            entry.stdinDisabled = disabled;
          }
        },
        refreshLayout() {
          safeFit();
        },
        getScrollPosition() {
          const buffer = getActiveBuffer();
          return buffer?.ydisp ?? 0;
        },
        scrollToLine(line: number) {
          if (!terminalRef.current) {
            return;
          }
          if (Number.isFinite(line)) {
            terminalRef.current.scrollToLine(line);
          }
        },
        scrollToBottom() {
          terminalRef.current?.scrollToBottom();
        }
      }),
      [safeFit, getActiveBuffer, instanceId]
    );

    return (
      <div className="codex-terminal" role="presentation">
        <div className="codex-terminal__viewport" ref={containerRef} />
      </div>
    );
  }
);

CodexTerminal.displayName = 'CodexTerminal';
