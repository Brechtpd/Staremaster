import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import type {
  WorktreeTerminalDescriptor,
  TerminalOutputPayload,
  TerminalExitPayload,
  TerminalResizeRequest
} from '../../shared/ipc';

interface TerminalEvents {
  'terminal-output': (payload: TerminalOutputPayload) => void;
  'terminal-exit': (payload: TerminalExitPayload) => void;
  'terminal-started': (descriptor: WorktreeTerminalDescriptor) => void;
}

interface TerminalSession {
  descriptor: WorktreeTerminalDescriptor;
  process: IPty;
}

interface ShellResolution {
  command: string;
  args: string[];
  display: string;
}

let ptyModulePromise: Promise<typeof import('node-pty')> | null = null;

const loadPty = async (): Promise<typeof import('node-pty')> => {
  if (!ptyModulePromise) {
    ptyModulePromise = import('node-pty');
  }
  return ptyModulePromise;
};

const resolveShell = (): ShellResolution => {
  if (process.platform === 'win32') {
    const shell = process.env.COMSPEC ?? 'cmd.exe';
    return {
      command: shell,
      args: [],
      display: shell
    };
  }

  const shell = process.env.SHELL ?? '/bin/bash';
  return {
    command: shell,
    args: [],
    display: shell
  };
};

export class TerminalService extends EventEmitter<TerminalEvents> {
  private readonly sessions = new Map<string, TerminalSession>();

  private readonly pendingStarts = new Map<string, Promise<WorktreeTerminalDescriptor>>();

  constructor(private readonly getWorktreePath: (worktreeId: string) => string | null) {
    super();
  }

  async ensure(worktreeId: string): Promise<WorktreeTerminalDescriptor> {
    const existing = this.sessions.get(worktreeId);
    if (existing && existing.descriptor.status === 'running') {
      return existing.descriptor;
    }

    const pending = this.pendingStarts.get(worktreeId);
    if (pending) {
      return pending;
    }

    const launchPromise = this.launch(worktreeId);
    this.pendingStarts.set(worktreeId, launchPromise);
    try {
      return await launchPromise;
    } finally {
      this.pendingStarts.delete(worktreeId);
    }
  }

  async stop(worktreeId: string): Promise<void> {
    const session = this.sessions.get(worktreeId);
    if (!session) {
      return;
    }
    session.process.kill();
  }

  sendInput(worktreeId: string, data: string): void {
    const session = this.sessions.get(worktreeId);
    if (!session) {
      throw new Error(`No terminal session for worktree ${worktreeId}`);
    }
    if (session.descriptor.status !== 'running') {
      throw new Error(`Terminal session for ${worktreeId} is not running`);
    }
    session.process.write(data);
  }

  resize({ worktreeId, cols, rows }: TerminalResizeRequest): void {
    const session = this.sessions.get(worktreeId);
    if (!session || session.descriptor.status !== 'running') {
      return;
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
      return;
    }
    session.process.resize(Math.floor(cols), Math.floor(rows));
  }

  dispose(worktreeId: string): void {
    const session = this.sessions.get(worktreeId);
    if (!session) {
      return;
    }
    this.sessions.delete(worktreeId);
    session.process.kill();
  }

  private async launch(worktreeId: string): Promise<WorktreeTerminalDescriptor> {
    const cwd = this.getWorktreePath(worktreeId);
    if (!cwd) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }

    const { spawn } = await loadPty();
    const shell = resolveShell();

    console.log('[terminal] spawning shell', { shell: shell.display, cwd });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: process.env.TERM ?? 'xterm-256color',
      COLORTERM: process.env.COLORTERM ?? 'truecolor',
      FORCE_COLOR: process.env.FORCE_COLOR ?? '1'
    };

    const child = spawn(shell.command, shell.args, {
      cwd,
      cols: 120,
      rows: 30,
      env
    });

    const descriptor: WorktreeTerminalDescriptor = {
      sessionId: randomUUID(),
      worktreeId,
      shell: shell.display,
      pid: child.pid ?? -1,
      startedAt: new Date().toISOString(),
      status: 'running'
    };

    const session: TerminalSession = {
      descriptor,
      process: child
    };

    this.sessions.set(worktreeId, session);
    this.emit('terminal-started', descriptor);

    child.onData((chunk) => {
      const payload: TerminalOutputPayload = {
        sessionId: descriptor.sessionId,
        worktreeId,
        chunk
      };
      this.emit('terminal-output', payload);
    });

    child.onExit(({ exitCode, signal }) => {
      descriptor.status = 'exited';
      descriptor.exitCode = exitCode === undefined ? undefined : exitCode;
      descriptor.signal = signal === undefined ? undefined : signal;
      if (this.sessions.get(worktreeId)?.descriptor.sessionId === descriptor.sessionId) {
        this.sessions.delete(worktreeId);
      }
      const payload: TerminalExitPayload = {
        sessionId: descriptor.sessionId,
        worktreeId,
        exitCode: exitCode ?? null,
        signal: signal ?? null
      };
      this.emit('terminal-exit', payload);
    });

    return descriptor;
  }
}

