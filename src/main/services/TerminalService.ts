import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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

const HISTORY_REWRITE_APPEND_INTERVAL = 200;

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
  dirty: boolean;
  appendSinceRewrite: number;
}

interface TerminalServiceOptions {
  history?: {
    enabled: boolean;
    limit?: number;
  };
  persistDir?: string;
}

export class TerminalService extends EventEmitter<TerminalEvents> {
  private readonly sessionsById = new Map<string, TerminalSession>();

  private readonly sessionsByWorktree = new Map<string, Set<string>>();

  private readonly pendingStarts = new Map<string, Promise<WorktreeTerminalDescriptor>>();

  private readonly paneSessionMap = new Map<string, string>();

  private readonly historyEnabled: boolean;

  private readonly historyLimit: number;

  private readonly historyByKey = new Map<string, HistoryRecord>();

  private readonly historyLoadPromises = new Map<string, Promise<void>>();

  private readonly historyPersistPromises = new Map<string, Promise<void>>();

  private readonly persistDir?: string;

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
    this.persistDir = options?.persistDir;
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
    const descriptor = await this.start(worktreeId, options, paneId);
    if (this.historyEnabled) {
      const key = this.historyKey(worktreeId, paneId);
      if (!this.historyByKey.has(key)) {
        try {
          await this.loadPersistedHistory(key);
        } catch {
          // ignore failures, best effort
        }
      }
    }
    return descriptor;
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
      historyKeys.forEach((key) => {
        this.historyByKey.delete(key);
        this.deletePersistedHistory(key);
      });
      const defaultKey = this.historyKey(worktreeId);
      if (this.historyByKey.delete(defaultKey)) {
        this.deletePersistedHistory(defaultKey);
      } else {
        this.deletePersistedHistory(defaultKey);
      }
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

  private safeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  }

  private queuePersistTask(key: string, task: () => Promise<void>): void {
    if (!this.persistDir) return;
    const previous = this.historyPersistPromises.get(key) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error) => {
        console.warn('[terminal] history persistence failed', { key, error });
      })
      .finally(() => {
        if (this.historyPersistPromises.get(key) === next) {
          this.historyPersistPromises.delete(key);
        }
      });
    this.historyPersistPromises.set(key, next);
  }

  private appendPersistedEvent(key: string, event: HistoryEvent): void {
    if (!this.persistDir) return;
    this.queuePersistTask(key, async () => {
      const dir = this.persistDir!;
      const file = path.join(dir, `${this.safeKey(key)}.jsonl`);
      await fs.mkdir(dir, { recursive: true });
      const line = JSON.stringify(event) + '\n';
      await fs.appendFile(file, line, 'utf8');
    });
  }

  private rewritePersistedHistory(key: string, record: HistoryRecord): void {
    if (!this.persistDir) return;
    const eventsSnapshot = record.events.map((event) => ({ ...event }));
    this.queuePersistTask(key, async () => {
      const dir = this.persistDir!;
      const file = path.join(dir, `${this.safeKey(key)}.jsonl`);
      if (eventsSnapshot.length === 0) {
        try {
          await fs.unlink(file);
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err?.code !== 'ENOENT') {
            throw err;
          }
        }
        return;
      }
      await fs.mkdir(dir, { recursive: true });
      const content = eventsSnapshot.map((event) => JSON.stringify(event)).join('\n') + '\n';
      await fs.writeFile(file, content, 'utf8');
    });
    record.dirty = false;
    record.appendSinceRewrite = 0;
  }

  private deletePersistedHistory(key: string): void {
    if (!this.persistDir) return;
    this.queuePersistTask(key, async () => {
      const file = path.join(this.persistDir!, `${this.safeKey(key)}.jsonl`);
      try {
        await fs.unlink(file);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code && err.code !== 'ENOENT') {
          throw err;
        }
      }
    });
  }

  private async loadPersistedHistory(key: string): Promise<void> {
    if (!this.persistDir) return;
    if (this.historyByKey.has(key)) return;

    const ongoing = this.historyLoadPromises.get(key);
    if (ongoing) {
      await ongoing;
      return;
    }

    const loadPromise = (async () => {
      const file = path.join(this.persistDir!, `${this.safeKey(key)}.jsonl`);
      const record: HistoryRecord = {
        events: [],
        lastEventId: 0,
        firstEventId: 1,
        totalLength: 0,
        dirty: false,
        appendSinceRewrite: 0
      };

      try {
        const raw = await fs.readFile(file, 'utf8');
        for (const line of raw.split('\n')) {
          const trim = line.trim();
          if (!trim) continue;
          try {
            const parsed = JSON.parse(trim) as HistoryEvent;
            if (typeof parsed.id === 'number' && typeof parsed.data === 'string') {
              record.events.push(parsed);
              record.lastEventId = Math.max(record.lastEventId, parsed.id);
              record.totalLength += parsed.data.length;
            }
          } catch {
            // ignore malformed entries
          }
          while (record.totalLength > this.historyLimit && record.events.length > 1) {
            const removed = record.events.shift()!;
            record.totalLength -= removed.data.length;
            record.firstEventId = record.events[0]?.id ?? record.lastEventId + 1;
          }
        }
        if (record.events.length > 0) {
          record.firstEventId = record.events[0].id;
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code && err.code !== 'ENOENT') {
          console.warn('[terminal] failed to load history', { key, error: err });
        }
      } finally {
        record.dirty = false;
        record.appendSinceRewrite = 0;
        this.historyByKey.set(key, record);
      }
    })()
      .finally(() => {
        this.historyLoadPromises.delete(key);
      });

    this.historyLoadPromises.set(key, loadPromise);
    await loadPromise;
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
        totalLength: 0,
        dirty: false,
        appendSinceRewrite: 0
      };
      this.historyByKey.set(key, record);
    }
    const nextId = record.lastEventId + 1;
    const event = { id: nextId, data: chunk };
    record.events.push(event);
    record.lastEventId = nextId;
    if (record.events.length === 1) {
      record.firstEventId = nextId;
    }
    record.totalLength += chunk.length;
    let trimmed = false;
    while (record.totalLength > this.historyLimit && record.events.length > 1) {
      const removed = record.events.shift()!;
      record.totalLength -= removed.data.length;
      record.firstEventId = record.events[0]?.id ?? record.lastEventId + 1;
      trimmed = true;
    }
    record.appendSinceRewrite += 1;
    if (trimmed) {
      record.dirty = true;
    }
    this.appendPersistedEvent(key, event);
    if (record.dirty && record.appendSinceRewrite >= HISTORY_REWRITE_APPEND_INTERVAL) {
      this.rewritePersistedHistory(key, record);
    }
    return nextId;
  }

  async getSnapshot(worktreeId: string, paneId?: string): Promise<TerminalSnapshot> {
    if (!this.historyEnabled) {
      throw new Error('Terminal history not enabled');
    }
    const key = this.historyKey(worktreeId, paneId);
    let record = this.historyByKey.get(key);
    if (!record) {
      await this.loadPersistedHistory(key);
      record = this.historyByKey.get(key);
    }
    if (!record) {
      return { content: '', lastEventId: 0 };
    }
    const content = record.events.map((event) => event.data).join('');
    return {
      content,
      lastEventId: record.lastEventId
    };
  }

  async getDelta(worktreeId: string, afterEventId: number, paneId?: string): Promise<TerminalDelta> {
    if (!this.historyEnabled) {
      throw new Error('Terminal history not enabled');
    }
    const key = this.historyKey(worktreeId, paneId);
    let record = this.historyByKey.get(key);
    if (!record) {
      await this.loadPersistedHistory(key);
      record = this.historyByKey.get(key);
    }
    if (!record) {
      return { chunks: [], lastEventId: 0 };
    }

    if (afterEventId < record.firstEventId) {
      const snapshot = await this.getSnapshot(worktreeId, paneId);
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
