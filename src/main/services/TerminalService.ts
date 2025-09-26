import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import type {
  WorktreeTerminalDescriptor,
  TerminalOutputPayload,
  TerminalExitPayload,
  TerminalResizeRequest,
  TerminalChunk,
  TerminalSnapshot,
  TerminalDelta
} from '../../shared/ipc';

type TerminalEvents = {
  'terminal-output': [TerminalOutputPayload];
  'terminal-exit': [TerminalExitPayload];
  'terminal-started': [WorktreeTerminalDescriptor];
};

export interface TerminalLaunchOptions {
  startupCommand?: string;
  respondToCursorProbe?: boolean;
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

interface TerminalSession {
  descriptor: WorktreeTerminalDescriptor;
  process: IPty;
  paneId?: string;
}

interface HistoryEvent {
  id: number;
  data: string;
}

interface HistoryRecord {
  events: HistoryEvent[];
  lastEventId: number;
  firstEventId: number;
  totalLength: number;
}

interface TerminalServiceOptions {
  history?: {
    enabled: boolean;
    limit?: number;
  };
}

export class TerminalService extends EventEmitter<TerminalEvents> {
  private readonly sessionsById = new Map<string, TerminalSession>();

  private readonly sessionsByWorktree = new Map<string, Set<string>>();

  private readonly pendingStarts = new Map<string, Promise<WorktreeTerminalDescriptor>>();

  private readonly paneSessionMap = new Map<string, string>();

  private readonly historyEnabled: boolean;

  private readonly historyLimit: number;

  private readonly historyByKey = new Map<string, HistoryRecord>();

  private getPaneKey(worktreeId: string, paneId?: string | null): string | null {
    if (!paneId) {
      return null;
    }
    return `${worktreeId}:${paneId}`;
  }

  constructor(
    private readonly getWorktreePath: (worktreeId: string) => string | null,
    options?: TerminalServiceOptions
  ) {
    super();
    this.historyEnabled = options?.history?.enabled ?? false;
    this.historyLimit = options?.history?.limit ?? 500_000;
  }

  async start(
    worktreeId: string,
    options?: TerminalLaunchOptions,
    paneId?: string
  ): Promise<WorktreeTerminalDescriptor> {
    const paneKey = this.getPaneKey(worktreeId, paneId);
    const pendingKey = paneKey ?? `worktree:${worktreeId}`;

    if (paneKey) {
      const existingSessionId = this.paneSessionMap.get(paneKey);
      if (existingSessionId) {
        const existingSession = this.sessionsById.get(existingSessionId);
        if (existingSession && existingSession.descriptor.status === 'running') {
          return existingSession.descriptor;
        }
      }
    } else {
      const defaultSessionId = this.getDefaultSessionId(worktreeId);
      if (defaultSessionId) {
        const session = this.sessionsById.get(defaultSessionId);
        if (session && session.descriptor.status === 'running') {
          return session.descriptor;
        }
      }
    }

    const pending = this.pendingStarts.get(pendingKey);
    if (pending) {
      return pending;
    }

    const launchPromise = this.launch(worktreeId, options, paneId).then((descriptor) => {
      if (paneKey) {
        this.paneSessionMap.set(paneKey, descriptor.sessionId);
      }
      return descriptor;
    });

    this.pendingStarts.set(pendingKey, launchPromise);
    try {
      return await launchPromise;
    } finally {
      this.pendingStarts.delete(pendingKey);
    }
  }

  async ensure(
    worktreeId: string,
    options?: TerminalLaunchOptions,
    paneId?: string
  ): Promise<WorktreeTerminalDescriptor> {
    return this.start(worktreeId, options, paneId);
  }

  private resolveSessionId(
    worktreeId: string,
    options?: { sessionId?: string; paneId?: string }
  ): string | undefined {
    if (options?.sessionId) {
      return options.sessionId;
    }
    if (options?.paneId) {
      const paneKey = this.getPaneKey(worktreeId, options.paneId);
      if (paneKey) {
        const mapped = this.paneSessionMap.get(paneKey);
        if (mapped) {
          return mapped;
        }
      }
    }
    return this.getDefaultSessionId(worktreeId);
  }

  async stop(
    worktreeId: string,
    options?: { sessionId?: string; paneId?: string }
  ): Promise<void> {
    const targetSessionId = this.resolveSessionId(worktreeId, options);
    if (!targetSessionId) {
      return;
    }
    const session = this.sessionsById.get(targetSessionId);
    if (!session || session.descriptor.worktreeId !== worktreeId) {
      return;
    }
    session.process.kill();
  }

  sendInput(
    worktreeId: string,
    data: string,
    options?: { sessionId?: string; paneId?: string }
  ): void {
    const targetSessionId = this.resolveSessionId(worktreeId, options);
    if (!targetSessionId) {
      throw new Error(`No terminal session for worktree ${worktreeId}`);
    }
    const session = this.sessionsById.get(targetSessionId);
    if (!session || session.descriptor.worktreeId !== worktreeId) {
      throw new Error(`No terminal session ${targetSessionId} for worktree ${worktreeId}`);
    }
    if (session.descriptor.status !== 'running') {
      throw new Error(`Terminal session for ${worktreeId} is not running`);
    }
    session.process.write(data);
  }

  resize({ worktreeId, sessionId, paneId, cols, rows }: TerminalResizeRequest): void {
    const targetSessionId = this.resolveSessionId(worktreeId, { sessionId, paneId });
    if (!targetSessionId) {
      return;
    }
    const session = this.sessionsById.get(targetSessionId);
    if (!session || session.descriptor.status !== 'running' || session.descriptor.worktreeId !== worktreeId) {
      return;
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
      return;
    }
    session.process.resize(Math.floor(cols), Math.floor(rows));
  }

  dispose(worktreeId: string): void {
    const sessionIds = this.sessionsByWorktree.get(worktreeId);
    if (!sessionIds) {
      return;
    }
    sessionIds.forEach((sessionId) => {
      const session = this.sessionsById.get(sessionId);
      if (session) {
        session.process.kill();
      }
    });
    this.sessionsByWorktree.delete(worktreeId);
    const paneKeys: string[] = [];
    this.paneSessionMap.forEach((value, key) => {
      if (key.startsWith(`${worktreeId}:`)) {
        paneKeys.push(key);
      }
    });
    paneKeys.forEach((key) => this.paneSessionMap.delete(key));
    const pendingKeys: string[] = [];
    this.pendingStarts.forEach((_value, key) => {
      if (key === `worktree:${worktreeId}` || key.startsWith(`${worktreeId}:`)) {
        pendingKeys.push(key);
      }
    });
    pendingKeys.forEach((key) => this.pendingStarts.delete(key));

    if (this.historyEnabled) {
      const historyKeys: string[] = [];
      this.historyByKey.forEach((_value, key) => {
        if (key.startsWith(`${worktreeId}:`)) {
          historyKeys.push(key);
        }
      });
      historyKeys.forEach((key) => this.historyByKey.delete(key));
      this.historyByKey.delete(this.historyKey(worktreeId));
    }
  }

  private async launch(
    worktreeId: string,
    options?: TerminalLaunchOptions,
    paneId?: string
  ): Promise<WorktreeTerminalDescriptor> {
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

    const args = [...shell.args];

    if (options?.startupCommand) {
      if (process.platform === 'win32') {
        args.push('/d', '/s', '/k', options.startupCommand);
      } else {
        const interactiveShell = shell.command;
        args.push('-lc', `${options.startupCommand} && exec ${interactiveShell}`);
      }
    }

    const child = spawn(shell.command, args, {
      cwd,
      cols: 120,
      rows: 30,
      env
    });

    const shouldRespondToCursorProbe = Boolean(options?.respondToCursorProbe);
    let dsrBuffer = '';

    const respondToCursorProbe = () => {
      child.write('\u001b[1;1R');
    };

    const descriptor: WorktreeTerminalDescriptor = {
      sessionId: randomUUID(),
      worktreeId,
      shell: shell.display,
      pid: child.pid ?? -1,
      startedAt: new Date().toISOString(),
      status: 'running',
      paneId
    };

    const session: TerminalSession = {
      descriptor,
      process: child,
      paneId
    };

    this.sessionsById.set(descriptor.sessionId, session);
    const worktreeSessions = this.sessionsByWorktree.get(worktreeId) ?? new Set<string>();
    worktreeSessions.add(descriptor.sessionId);
    this.sessionsByWorktree.set(worktreeId, worktreeSessions);
    this.emit('terminal-started', descriptor);

    child.onData((chunk) => {
      if (shouldRespondToCursorProbe && chunk.includes('\u001b')) {
        dsrBuffer += chunk;
        let index = dsrBuffer.indexOf('\u001b[6n');
        while (index !== -1) {
          respondToCursorProbe();
          dsrBuffer = dsrBuffer.slice(index + 4);
          index = dsrBuffer.indexOf('\u001b[6n');
        }
        if (dsrBuffer.length > 32) {
          dsrBuffer = dsrBuffer.slice(-32);
        }
      }
      const eventId = this.recordHistoryEvent(worktreeId, paneId, chunk);
      const payload: TerminalOutputPayload = {
        sessionId: descriptor.sessionId,
        worktreeId,
        chunk,
        paneId,
        eventId
      };
      this.emit('terminal-output', payload);
    });

    child.onExit(({ exitCode, signal }) => {
      console.log('[terminal] exit', { worktreeId, paneId, exitCode, signal, sessionId: descriptor.sessionId });
      descriptor.status = 'exited';
      console.log('[terminal] exit', { worktreeId, paneId, exitCode, signal, sessionId: descriptor.sessionId });
      descriptor.exitCode = exitCode === undefined ? undefined : exitCode;
      descriptor.signal = signal === undefined ? undefined : String(signal);
      this.sessionsById.delete(descriptor.sessionId);
      const byWorktree = this.sessionsByWorktree.get(worktreeId);
      if (byWorktree) {
        byWorktree.delete(descriptor.sessionId);
        if (byWorktree.size === 0) {
          this.sessionsByWorktree.delete(worktreeId);
        }
      }
      if (paneId) {
        const key = `${worktreeId}:${paneId}`;
        const boundSessionId = this.paneSessionMap.get(key);
        if (boundSessionId === descriptor.sessionId) {
          this.paneSessionMap.delete(key);
        }
      }
      const payload: TerminalExitPayload = {
        sessionId: descriptor.sessionId,
        worktreeId,
        exitCode: exitCode ?? null,
        signal: signal === undefined || signal === null ? null : String(signal)
      };
      this.emit('terminal-exit', payload);
    });

    if (shouldRespondToCursorProbe) {
      respondToCursorProbe();
    }

    return descriptor;
  }

  private getDefaultSessionId(worktreeId: string): string | undefined {
    const sessions = this.sessionsByWorktree.get(worktreeId);
    if (!sessions || sessions.size === 0) {
      return undefined;
    }
    let last: string | undefined;
    sessions.forEach((id) => {
      last = id;
    });
    return last;
  }

  private historyKey(worktreeId: string, paneId?: string | null): string {
    return paneId ? `${worktreeId}:${paneId}` : `${worktreeId}::default`;
  }

  private recordHistoryEvent(worktreeId: string, paneId: string | undefined, chunk: string): number | undefined {
    if (!this.historyEnabled) {
      return undefined;
    }
    const key = this.historyKey(worktreeId, paneId);
    let record = this.historyByKey.get(key);
    if (!record) {
      record = {
        events: [],
        lastEventId: 0,
        firstEventId: 1,
        totalLength: 0
      };
      this.historyByKey.set(key, record);
    }
    const nextId = record.lastEventId + 1;
    record.events.push({ id: nextId, data: chunk });
    record.lastEventId = nextId;
    if (record.events.length === 1) {
      record.firstEventId = nextId;
    }
    record.totalLength += chunk.length;
    while (record.totalLength > this.historyLimit && record.events.length > 1) {
      const removed = record.events.shift()!;
      record.totalLength -= removed.data.length;
      record.firstEventId = record.events[0]?.id ?? record.lastEventId + 1;
    }
    return nextId;
  }

  getSnapshot(worktreeId: string, paneId?: string): TerminalSnapshot {
    if (!this.historyEnabled) {
      throw new Error('Terminal history not enabled');
    }
    const key = this.historyKey(worktreeId, paneId);
    const record = this.historyByKey.get(key);
    if (!record) {
      return { content: '', lastEventId: 0 };
    }
    const content = record.events.map((event) => event.data).join('');
    return {
      content,
      lastEventId: record.lastEventId
    };
  }

  getDelta(worktreeId: string, afterEventId: number, paneId?: string): TerminalDelta {
    if (!this.historyEnabled) {
      throw new Error('Terminal history not enabled');
    }
    const key = this.historyKey(worktreeId, paneId);
    const record = this.historyByKey.get(key);
    if (!record) {
      return { chunks: [], lastEventId: 0 };
    }

    if (afterEventId < record.firstEventId) {
      const snapshot = this.getSnapshot(worktreeId, paneId);
      return {
        chunks: [],
        lastEventId: snapshot.lastEventId,
        snapshot: snapshot.content
      };
    }

    const chunks: TerminalChunk[] = record.events
      .filter((event) => event.id > afterEventId)
      .map((event) => ({ id: event.id, data: event.data }));

    return {
      chunks,
      lastEventId: record.lastEventId
    };
  }
}
