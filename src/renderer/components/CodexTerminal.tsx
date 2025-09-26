import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { Terminal, type IDisposable } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

interface TerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  dataDisposable: IDisposable | null;
  refCount: number;
  stdinDisabled: boolean;
  disposeTimer: number | null;
}

const terminalRegistry = new Map<string, TerminalEntry>();

export interface CodexTerminalHandle {
  write(data: string): void;
  clear(): void;
  focus(): void;
  setStdinDisabled(disabled: boolean): void;
  refreshLayout(): void;
  forceRender(): void;
  getScrollPosition(): number;
  scrollToLine(line: number): void;
  scrollToBottom(): void;
}

interface CodexTerminalProps {
  onData(data: string): void;
  instanceId: string;
  onResize?: (size: { cols: number; rows: number }) => void;
}

export const CodexTerminal = React.forwardRef<CodexTerminalHandle, CodexTerminalProps>(
  ({ onData, instanceId, onResize }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const dataHandlerRef = useRef(onData);
    const themeRef = useRef({
      background: '#1c1d1f',
      foreground: '#f8fafc',
      cursor: '#f8fafc',
      selection: 'rgba(148, 163, 184, 0.35)'
    });
    const pendingRef = useRef<string[]>([]);
    const readyRef = useRef(false);

    const retryTokenRef = useRef<number | null>(null);
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const resizeHandlerRef = useRef(onResize);
    const [contextMenu, setContextMenu] = useState<{
      x: number;
      y: number;
      hasSelection: boolean;
    } | null>(null);

    const hideContextMenu = useCallback(() => {
      setContextMenu(null);
    }, []);

    useEffect(() => {
      resizeHandlerRef.current = onResize;
    }, [onResize]);

    useEffect(() => {
      if (!contextMenu) {
        return undefined;
      }
      const handlePointerDown = (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (target && target.closest('.codex-context-menu')) {
          return;
        }
        hideContextMenu();
      };
      const handleBlur = () => {
        hideContextMenu();
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          hideContextMenu();
        }
      };
      window.addEventListener('mousedown', handlePointerDown, true);
      window.addEventListener('blur', handleBlur);
      window.addEventListener('keydown', handleKeyDown);
      return () => {
        window.removeEventListener('mousedown', handlePointerDown, true);
        window.removeEventListener('blur', handleBlur);
        window.removeEventListener('keydown', handleKeyDown);
      };
    }, [contextMenu, hideContextMenu]);

    const notifyResize = useCallback(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      const cols = terminal.cols;
      const rows = terminal.rows;
      const current = lastSizeRef.current;
      if (current && current.cols === cols && current.rows === rows) {
        return;
      }
      lastSizeRef.current = { cols, rows };
      resizeHandlerRef.current?.({ cols, rows });
    }, []);

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

    const copyToClipboard = useCallback(async (text: string) => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'absolute';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        const succeeded = document.execCommand('copy');
        document.body.removeChild(textarea);
        return succeeded;
      } catch (error) {
        console.warn('[terminal] copy failed', error);
        return false;
      }
    }, []);

    const handleCopySelection = useCallback(async () => {
      const terminal = terminalRef.current;
      if (!terminal) {
        hideContextMenu();
        return;
      }
      const selection = terminal.getSelection();
      if (!selection) {
        hideContextMenu();
        return;
      }
      await copyToClipboard(selection);
      hideContextMenu();
    }, [copyToClipboard, hideContextMenu]);

    const handleCopyAll = useCallback(async () => {
      const terminal = terminalRef.current;
      if (!terminal) {
        hideContextMenu();
        return;
      }
      terminal.selectAll();
      const selection = terminal.getSelection();
      if (selection) {
        await copyToClipboard(selection);
      }
      terminal.clearSelection();
      hideContextMenu();
    }, [copyToClipboard, hideContextMenu]);

    const handlePaste = useCallback(async () => {
      const terminal = terminalRef.current;
      if (!terminal) {
        hideContextMenu();
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = await navigator.clipboard.readText();
          if (text) {
            const pasteCandidate = terminal as Terminal & { paste?: (value: string) => void };
            if (typeof pasteCandidate.paste === 'function') {
              pasteCandidate.paste(text);
            } else {
              terminal.write(text);
              dataHandlerRef.current(text);
            }
          }
        }
      } catch (error) {
        console.warn('[terminal] paste failed', error);
      }
      hideContextMenu();
    }, [hideContextMenu]);

    const handleContextMenu = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        const terminal = terminalRef.current;
        const selection = terminal?.getSelection() ?? '';
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          hasSelection: selection.trim().length > 0
        });
      },
      []
    );

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
        notifyResize();
      } catch (error) {
        console.warn('[terminal] fit failed', error);
        clearRetry();
        retryTokenRef.current = window.setTimeout(safeFit, 32);
      }
    }, [flushPending, notifyResize]);

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
          stdinDisabled: false,
          disposeTimer: null
        };
        terminalRegistry.set(instanceId, entry);
      }

      if (entry.disposeTimer !== null) {
        window.clearTimeout(entry.disposeTimer);
        entry.disposeTimer = null;
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
          notifyResize();
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
            if (entry.disposeTimer !== null) {
              window.clearTimeout(entry.disposeTimer);
            }
            entry.disposeTimer = window.setTimeout(() => {
              entry.terminal.dispose();
              terminalRegistry.delete(instanceId);
              entry.disposeTimer = null;
            }, 30000);
          }
        }
        terminalRef.current = null;
        fitAddonRef.current = null;
        readyRef.current = false;
        if (retryTokenRef.current !== null) {
          window.clearTimeout(retryTokenRef.current);
          retryTokenRef.current = null;
        }
        lastSizeRef.current = null;
      };
    }, [flushPending, safeFit, instanceId, notifyResize]);

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
          notifyResize();
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
          notifyResize();
        },
        forceRender() {
          const terminal = terminalRef.current;
          if (!terminal) {
            return;
          }
          const totalRows = terminal.rows;
          if (totalRows > 0) {
            terminal.refresh(0, totalRows - 1);
          } else {
            terminal.refresh(0, 0);
          }
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
      [safeFit, getActiveBuffer, instanceId, notifyResize]
    );

    return (
      <div className="codex-terminal" role="presentation" onContextMenu={handleContextMenu}>
        <div className="codex-terminal__viewport" ref={containerRef} />
        {contextMenu ? (
          <div
            className="codex-context-menu"
            style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
            role="menu"
          >
            <button
              type="button"
              className="codex-context-menu__item"
              onClick={handleCopySelection}
              disabled={!contextMenu.hasSelection}
            >
              Copy
            </button>
            <button type="button" className="codex-context-menu__item" onClick={handleCopyAll}>
              Copy All
            </button>
            <button type="button" className="codex-context-menu__item" onClick={handlePaste}>
              Paste
            </button>
          </div>
        ) : null}
      </div>
    );
  }
);

CodexTerminal.displayName = 'CodexTerminal';
