import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { promises as fs, createWriteStream, WriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CodexSessionDescriptor,
  CodexOutputPayload,
  CodexStatusPayload,
  WorktreeDescriptor,
  CodexStatus
} from '../../shared/ipc';
import { ProjectStore } from './ProjectStore';
import type { IPty } from 'node-pty';

export interface CodexEvents {
  'codex-output': (payload: CodexOutputPayload) => void;
  'codex-status': (payload: CodexStatusPayload) => void;
}

export interface ResumeDetectionState {
  buffer: string;
  resumeCaptured: boolean;
  resumeTarget: string | null;
}

export interface ResumeDetectionMatch {
  codexSessionId: string;
  command: string;
  alreadyCaptured: boolean;
}

const RESUME_COMMAND_REGEX = /codex resume --yolo ([0-9a-fA-F-][0-9a-fA-F-]{7,})/gi;
const MAX_RESUME_BUFFER = 512;

export const detectResumeCommands = (
  state: ResumeDetectionState,
  chunk: string
): ResumeDetectionMatch[] => {
  if (!chunk) {
    return [];
  }

  state.buffer += chunk;

  const results: ResumeDetectionMatch[] = [];
  let match: RegExpExecArray | null;
  let lastConsumedIndex = 0;
  RESUME_COMMAND_REGEX.lastIndex = 0;

  while ((match = RESUME_COMMAND_REGEX.exec(state.buffer)) !== null) {
    lastConsumedIndex = Math.max(lastConsumedIndex, RESUME_COMMAND_REGEX.lastIndex);
    const command = match[0];
    const codexSessionId = match[1];
    const alreadyCaptured = state.resumeCaptured && state.resumeTarget === codexSessionId;
    results.push({ codexSessionId, command, alreadyCaptured });
    state.resumeTarget = codexSessionId;
    state.resumeCaptured = true;
  }

  if (lastConsumedIndex > 0) {
    state.buffer = state.buffer.slice(lastConsumedIndex);
  }
  if (state.buffer.length > MAX_RESUME_BUFFER) {
    state.buffer = state.buffer.slice(-MAX_RESUME_BUFFER);
  }

  return results;
};

type ManagedSession = {
  descriptor: CodexSessionDescriptor;
  process: IPty;
  logPath: string;
  stream: WriteStream;
  dsrBuffer: string;
  resumeTarget?: string | null;
  resumeDetection: ResumeDetectionState;
  projectId: string;
};

const DEFAULT_CODEX_COMMAND = 'codex --yolo';
const CODEX_RESUME_TEMPLATE = 'codex resume --yolo';
const MAX_SESSION_LOOKUP_ATTEMPTS = 10;
const SESSION_LOOKUP_DELAY_MS = 500;
const SESSION_LOOKBACK_MS = 5 * 60 * 1000;

export class CodexSessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingStarts = new Map<string, Promise<CodexSessionDescriptor>>();
  private readonly logDir: string;

  constructor(private readonly store: ProjectStore) {
    super();
    this.logDir = path.join(this.store.getUserDataDir(), 'codex-logs');
  }

  getSessions(): CodexSessionDescriptor[] {
    return this.store.getState().sessions;
  }

  async start(worktree: WorktreeDescriptor, options?: { command?: string }): Promise<CodexSessionDescriptor> {
    const existing = this.sessions.get(worktree.id);
    if (existing) {
      return existing.descriptor;
    }

    const pending = this.pendingStarts.get(worktree.id);
    if (pending) {
      return pending;
    }

    const launchPromise = this.launchSession(worktree, options);
    this.pendingStarts.set(worktree.id, launchPromise);

    try {
      const descriptor = await launchPromise;
      return descriptor;
    } finally {
      this.pendingStarts.delete(worktree.id);
    }
  }

  private async launchSession(
    worktree: WorktreeDescriptor,
    options?: { command?: string }
  ): Promise<CodexSessionDescriptor> {
    const previousSession = this.findLatestSessionForWorktree(worktree.id);
    const resumeTarget = previousSession?.codexSessionId;
    const isAutoResume = Boolean(resumeTarget) && !options?.command;
    const command = options?.command ?? (resumeTarget ? `${CODEX_RESUME_TEMPLATE} ${resumeTarget}` : DEFAULT_CODEX_COMMAND);

    const startTimestamp = Date.now();
    const { spawn } = await loadPty();
    console.log('[codex] spawning', { command, cwd: worktree.path });

    const initialStatus: CodexStatus = isAutoResume ? 'resuming' : 'starting';

    const descriptor: CodexSessionDescriptor = {
      id: previousSession?.id ?? randomUUID(),
      worktreeId: worktree.id,
      status: initialStatus,
      startedAt: new Date().toISOString(),
      codexSessionId: resumeTarget ?? previousSession?.codexSessionId,
      lastError: undefined
    };

    await fs.mkdir(this.logDir, { recursive: true });
    const logPath = path.join(this.logDir, `${worktree.id}.log`);
    const stream = createWriteStream(logPath, { flags: 'a' });
    stream.write(`\n[${new Date().toISOString()}] Session started: ${command}\n`);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: process.env.TERM ?? 'xterm-256color',
      COLORTERM: process.env.COLORTERM ?? 'truecolor',
      FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
      CODEX_UNSAFE_ALLOW_NO_SANDBOX: process.env.CODEX_UNSAFE_ALLOW_NO_SANDBOX ?? '1'
    };

    const { shell, args } = resolveShellCommand(command);
    const child = spawn(shell, args, {
      cwd: worktree.path,
      cols: 120,
      rows: 30,
      env: childEnv
    });

    const managed: ManagedSession = {
      descriptor,
      process: child,
      logPath,
      stream,
      dsrBuffer: '',
      resumeTarget: isAutoResume ? resumeTarget : null,
      resumeDetection: {
        buffer: '',
        resumeCaptured: Boolean(isAutoResume && resumeTarget),
        resumeTarget: resumeTarget ?? null
      },
      projectId: worktree.projectId
    };

    this.sessions.set(worktree.id, managed);
    await this.store.upsertSession(descriptor);

    if (!resumeTarget) {
      void this.captureCodexSessionId(worktree.path, descriptor, managed, startTimestamp, worktree.id).catch((error) => {
        console.warn('[codex] failed to capture session id', error);
      });
    }

    const respondToCursorProbe = () => {
      child.write('\u001b[1;1R');
    };

    let promotedToRunning = false;

    const promoteRunning = () => {
      if (promotedToRunning) {
        return;
      }
      promotedToRunning = true;
      managed.descriptor.status = 'running';
      this.emit('codex-status', {
        sessionId: descriptor.id,
        worktreeId: worktree.id,
        status: 'running'
      });
      void this.store.patchSession(descriptor.id, {
        status: 'running'
      });
    };

    child.onData((chunk) => {
      console.log('[codex] chunk', chunk.length);
      promoteRunning();

      const resumeMatches = detectResumeCommands(managed.resumeDetection, chunk);
      for (const match of resumeMatches) {
        managed.resumeTarget = match.codexSessionId;
        managed.descriptor.codexSessionId = match.codexSessionId;
        void this.store.patchSession(descriptor.id, {
          codexSessionId: match.codexSessionId
        });
        if (!match.alreadyCaptured) {
          void this.store.updateCodexResumeCommand(worktree.id, match.command);
          void this.store.updateCodexResumeCommand(`project-root:${worktree.projectId}`, match.command);
        }
      }
      if (chunk.includes('\u001b')) {
        managed.dsrBuffer += chunk;
        let index = managed.dsrBuffer.indexOf('\u001b[6n');
        while (index !== -1) {
          respondToCursorProbe();
          managed.dsrBuffer = managed.dsrBuffer.slice(index + 4);
          index = managed.dsrBuffer.indexOf('\u001b[6n');
        }
        if (managed.dsrBuffer.length > 32) {
          managed.dsrBuffer = managed.dsrBuffer.slice(-32);
        }
      }
      managed.stream.write(chunk);
      this.emit('codex-output', {
        sessionId: descriptor.id,
        worktreeId: worktree.id,
        chunk
      });
      void this.store.patchSession(descriptor.id, {
        lastOutputAt: new Date().toISOString()
      });
      void this.store.patchWorktree(worktree.id, {
        codexStatus: 'running',
        lastError: undefined
      });
    });

    respondToCursorProbe();

    child.onExit(async ({ exitCode }) => {
      console.log('[codex] exit', exitCode);
      managed.descriptor.status = exitCode === 0 ? 'stopped' : 'error';
      if (exitCode !== 0) {
        managed.descriptor.lastError = `Codex process exited with code ${exitCode}`;
        if (managed.resumeTarget) {
          managed.descriptor.codexSessionId = undefined;
          managed.resumeTarget = null;
        }
      }
      managed.stream.write(`\n[${new Date().toISOString()}] Session exited with code ${exitCode}\n`);
      managed.stream.end();
      this.emit('codex-status', {
        sessionId: descriptor.id,
        worktreeId: worktree.id,
        status: managed.descriptor.status,
        error: managed.descriptor.lastError
      });
      this.sessions.delete(worktree.id);
      await this.store.patchSession(descriptor.id, {
        status: managed.descriptor.status,
        lastError: managed.descriptor.lastError,
        codexSessionId: managed.descriptor.codexSessionId
      });
      const resumeCommand = managed.descriptor.codexSessionId
        ? `${CODEX_RESUME_TEMPLATE} ${managed.descriptor.codexSessionId}`
        : null;
      await this.store.patchWorktree(worktree.id, {
        codexStatus: managed.descriptor.status,
        lastError: managed.descriptor.lastError
      });
      await this.store.updateCodexResumeCommand(worktree.id, resumeCommand);
      await this.store.updateCodexResumeCommand(`project-root:${worktree.projectId}`, resumeCommand);

      const shouldRetryFresh = exitCode !== 0 && isAutoResume;
      if (shouldRetryFresh) {
        console.warn('[codex] resume failed, attempting fresh session for', worktree.path);
        try {
          await this.start(worktree, { command: DEFAULT_CODEX_COMMAND });
        } catch (error) {
          console.error('[codex] fallback start failed', error);
        }
      }
    });

    this.emit('codex-status', {
      sessionId: descriptor.id,
      worktreeId: worktree.id,
      status: initialStatus
    });

    return descriptor;
  }

  async stop(worktreeId: string): Promise<void> {
    const session = this.sessions.get(worktreeId);
    if (!session) {
      throw new Error(`No running Codex session for worktree ${worktreeId}`);
    }

    session.stream.write(`\n[${new Date().toISOString()}] Session stopping via user request\n`);
    session.process.kill();
    await this.store.patchSession(session.descriptor.id, {
      status: 'stopped'
    });
    this.emit('codex-status', {
      sessionId: session.descriptor.id,
      worktreeId,
      status: 'stopped'
    });
  }

  async sendInput(worktreeId: string, input: string): Promise<void> {
    const session = this.sessions.get(worktreeId);
    if (!session) {
      throw new Error(`No running Codex session for worktree ${worktreeId}`);
    }
    session.process.write(input);
  }

  async getLog(worktreeId: string): Promise<string> {
    const logPath = path.join(this.logDir, `${worktreeId}.log`);
    try {
      return await fs.readFile(logPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  private findLatestSessionForWorktree(worktreeId: string): CodexSessionDescriptor | undefined {
    const candidates = this.store
      .getState()
      .sessions.filter((session) => session.worktreeId === worktreeId && Boolean(session.codexSessionId));
    if (candidates.length === 0) {
      return undefined;
    }
    return candidates.reduce<CodexSessionDescriptor | undefined>((latest, current) => {
      if (!latest) {
        return current;
      }
      const latestTime = Date.parse(latest.startedAt ?? '') || 0;
      const currentTime = Date.parse(current.startedAt ?? '') || 0;
      return currentTime > latestTime ? current : latest;
    }, undefined);
  }

  private async captureCodexSessionId(
    cwd: string,
    descriptor: CodexSessionDescriptor,
    managed: ManagedSession,
    sessionStartMs: number,
    worktreeId: string
  ): Promise<void> {
    const sessionId = await this.locateCodexSessionId(cwd, sessionStartMs, managed.resumeTarget);
    if (!sessionId) {
      console.warn('[codex] unable to determine codex session id for', cwd);
      return;
    }
    managed.descriptor.codexSessionId = sessionId;
    managed.resumeTarget = sessionId;
    descriptor.codexSessionId = sessionId;
    await this.store.patchSession(descriptor.id, {
      codexSessionId: sessionId
    });
    const command = `${CODEX_RESUME_TEMPLATE} ${sessionId}`;
    await this.store.updateCodexResumeCommand(worktreeId, command);
    await this.store.updateCodexResumeCommand(`project-root:${managed.projectId}`, command);
    console.log('[codex] captured session id', sessionId, 'for', cwd);
  }

  private async locateCodexSessionId(
    cwd: string,
    sessionStartMs: number,
    ignoreSessionId?: string | null
  ): Promise<string | null> {
    const root = path.join(os.homedir(), '.codex', 'sessions');
    for (let attempt = 0; attempt < MAX_SESSION_LOOKUP_ATTEMPTS; attempt += 1) {
      const match = await this.scanCodexSessions(root, cwd, sessionStartMs, ignoreSessionId);
      if (match) {
        return match;
      }
      await delay(SESSION_LOOKUP_DELAY_MS);
    }
    return null;
  }

  private async scanCodexSessions(
    root: string,
    cwd: string,
    sessionStartMs: number,
    ignoreSessionId?: string | null
  ): Promise<string | null> {
    try {
      await fs.access(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    const dayOffsets = [0, -1];
    const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
    for (const offset of dayOffsets) {
      const dir = this.resolveSessionsDirForOffset(root, sessionStartMs, offset);
      if (!dir) {
        continue;
      }
      try {
        const entries = await fs.readdir(dir);
        await Promise.all(
          entries
            .filter((name) => name.endsWith('.jsonl'))
            .map(async (name) => {
              const filePath = path.join(dir, name);
              try {
                const stat = await fs.stat(filePath);
                if (stat.mtimeMs + SESSION_LOOKBACK_MS >= sessionStartMs) {
                  candidates.push({ filePath, mtimeMs: stat.mtimeMs });
                }
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                  console.warn('[codex] failed to stat session file', filePath, error);
                }
              }
            })
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[codex] unable to read sessions dir', dir, error);
        }
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const candidate of candidates) {
      const meta = await this.readSessionMeta(candidate.filePath);
      if (!meta) {
        continue;
      }
      if (meta.cwd === cwd && typeof meta.id === 'string' && (!ignoreSessionId || meta.id !== ignoreSessionId)) {
        return meta.id;
      }
    }

    return null;
  }

  private resolveSessionsDirForOffset(root: string, referenceMs: number, dayOffset: number): string | null {
    const referenceDate = new Date(referenceMs + dayOffset * 24 * 60 * 60 * 1000);
    if (Number.isNaN(referenceDate.getTime())) {
      return null;
    }
    const year = referenceDate.getFullYear().toString();
    const month = (referenceDate.getMonth() + 1).toString().padStart(2, '0');
    const day = referenceDate.getDate().toString().padStart(2, '0');
    return path.join(root, year, month, day);
  }

  private async readSessionMeta(filePath: string): Promise<{ id?: string; cwd?: string } | null> {
    try {
      const buffer = await fs.readFile(filePath, 'utf8');
      const newlineIndex = buffer.indexOf('\n');
      const firstLine = newlineIndex >= 0 ? buffer.slice(0, newlineIndex) : buffer;
      const parsed = JSON.parse(firstLine) as {
        payload?: {
          id?: string;
          cwd?: string;
        };
      };
      return parsed.payload ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[codex] failed to read session meta', filePath, error);
      }
      return null;
    }
  }
}

type ShellMode = 'posix' | 'powershell';

const withCodexEnv = (command: string, mode: ShellMode): string => {
  const shouldPrefix = process.env.CODEX_UNSAFE_ALLOW_NO_SANDBOX !== '0';
  if (!shouldPrefix) {
    return command;
  }
  if (mode === 'powershell') {
    return `$env:CODEX_UNSAFE_ALLOW_NO_SANDBOX = '1'; ${command}`;
  }
  return `CODEX_UNSAFE_ALLOW_NO_SANDBOX=1 ${command}`;
};

const resolveShellCommand = (command: string): { shell: string; args: string[] } => {
  if (process.platform === 'win32') {
    const configuredShell = process.env.SHELL;
    if (configuredShell) {
      const lower = configuredShell.toLowerCase();
      const isPowerShell = lower.includes('powershell') || lower.endsWith('pwsh') || lower.endsWith('pwsh.exe');
      if (isPowerShell) {
        return {
          shell: configuredShell,
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            withCodexEnv(command, 'powershell')
          ]
        };
      }
      return {
        shell: configuredShell,
        args: ['-lc', withCodexEnv(command, 'posix')]
      };
    }

    return {
      shell: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        withCodexEnv(command, 'powershell')
      ]
    };
  }

  const shell = process.env.SHELL ?? 'bash';
  return {
    shell,
    args: ['-lc', withCodexEnv(command, 'posix')]
  };
};

let ptyModulePromise: Promise<typeof import('node-pty')> | null = null;

const loadPty = async (): Promise<typeof import('node-pty')> => {
  if (!ptyModulePromise) {
    ptyModulePromise = import('node-pty');
  }

  return ptyModulePromise;
};
