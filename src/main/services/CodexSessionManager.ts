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

const ANSI_ESCAPE = '\u001b';
const SESSION_ID_POLL_INTERVAL_MS = 500;
const SESSION_ID_POLL_TIMEOUT_MS = 15_000;
const SESSION_CAPTURE_LOOKBACK_MS = 5 * 60 * 1000;
const SESSION_REFRESH_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SESSION_PREVIEW_MAX_CHARS = 2_000;

type ManagedSession = {
  descriptor: CodexSessionDescriptor;
  process: IPty;
  logPath: string;
  stream: WriteStream;
  dsrBuffer: string;
  expectedSessionId?: string | null;
  projectId: string;
  sessionWorktreeId: string;
};

const DEFAULT_CODEX_COMMAND = 'codex --yolo';
const CODEX_RESUME_TEMPLATE = 'codex resume --yolo';

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
    const storedSessionId = previousSession?.codexSessionId ?? null;
    const manualCommand = options?.command ?? null;
    const resumeTarget = manualCommand ? null : storedSessionId;
    const isAutoResume = Boolean(resumeTarget) && !manualCommand;
    const command = manualCommand ?? (resumeTarget ? `${CODEX_RESUME_TEMPLATE} ${resumeTarget}` : DEFAULT_CODEX_COMMAND);

    const startTimestamp = Date.now();
    const { spawn } = await loadPty();
    console.log('[codex] spawning', { command, cwd: worktree.path });

    const initialStatus: CodexStatus = isAutoResume ? 'resuming' : 'starting';

    if (previousSession?.id) {
      await this.store.patchSession(previousSession.id, {
        status: 'stopped'
      });
    }

    const descriptor: CodexSessionDescriptor = {
      id: randomUUID(),
      worktreeId: worktree.id,
      status: initialStatus,
      startedAt: new Date().toISOString(),
      codexSessionId: resumeTarget ?? undefined,
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
      expectedSessionId: resumeTarget ?? null,
      projectId: worktree.projectId,
      sessionWorktreeId: worktree.id
    };

    this.sessions.set(worktree.id, managed);
    await this.store.upsertSession(descriptor);
    await this.store.setProjectDefaultWorktree(worktree.projectId, worktree.id);

    void this.captureCodexSessionId(worktree.path, descriptor, managed, startTimestamp, worktree.id, {
      expected: resumeTarget,
      isAutoResume
    }).catch((error) => {
      console.warn('[codex] failed to capture session id', error);
    });

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

      if (chunk.includes(ANSI_ESCAPE)) {
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
      await this.store.patchWorktree(worktree.id, {
        codexStatus: managed.descriptor.status,
        lastError: managed.descriptor.lastError
      });
      if (managed.descriptor.codexSessionId) {
        await this.store.setProjectDefaultWorktree(worktree.projectId, managed.sessionWorktreeId);
      }

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

  async refreshCodexSessionId(worktreeId: string, preferredId?: string | null): Promise<string | null> {
    const state = this.store.getState();
    const worktree = state.worktrees.find((item) => item.id === worktreeId);
    if (!worktree) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }

    const root = path.join(os.homedir(), '.codex', 'sessions');
    let canonicalCwd = worktree.path;
    try {
      canonicalCwd = await fs.realpath(worktree.path);
    } catch {
      // fall back to the worktree path when resolution fails
    }

    const candidates = await this.collectCodexSessionCandidates(
      root,
      canonicalCwd,
      Date.now(),
      SESSION_REFRESH_LOOKBACK_MS
    );

    if (candidates.length === 0) {
      console.warn('[codex] refresh session id failed to locate entry for', worktree.path);
      return null;
    }

    const running = this.sessions.get(worktreeId);
    const latest = this.findLatestSessionForWorktree(worktreeId);
    const previousSessionId = running?.descriptor.codexSessionId ?? latest?.codexSessionId ?? null;

    if (preferredId === null) {
      await this.clearStoredSessionId(worktreeId);
      return null;
    }

    const validIds = new Set(candidates.map((candidate) => candidate.id));
    let sessionId = preferredId ?? previousSessionId ?? null;

    if (sessionId && !validIds.has(sessionId)) {
      sessionId = null;
    }

    if (!sessionId) {
      sessionId = candidates[0]?.id ?? null;
    }

    if (!sessionId) {
      await this.clearStoredSessionId(worktreeId);
      return null;
    }

    if (running) {
      running.descriptor.codexSessionId = sessionId;
      running.expectedSessionId = sessionId;
    }

    if (latest) {
      if (latest.codexSessionId !== sessionId) {
        await this.store.patchSession(latest.id, { codexSessionId: sessionId });
      }
    } else {
      const descriptor: CodexSessionDescriptor = {
        id: randomUUID(),
        worktreeId,
        status: 'stopped',
        startedAt: new Date().toISOString(),
        codexSessionId: sessionId
      };
      await this.store.upsertSession(descriptor);
    }

    await this.store.setProjectDefaultWorktree(worktree.projectId, worktree.id);
    return sessionId;
  }

  async listCodexSessionCandidates(
    worktreeId: string
  ): Promise<Array<{ id: string; mtimeMs: number; preview: string }>> {
    const state = this.store.getState();
    const worktree = state.worktrees.find((item) => item.id === worktreeId);
    if (!worktree) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }

    const root = path.join(os.homedir(), '.codex', 'sessions');
    let canonicalCwd = worktree.path;
    try {
      canonicalCwd = await fs.realpath(worktree.path);
    } catch {
      // fall back to the worktree path when resolution fails
    }

    const candidates = await this.collectCodexSessionCandidates(
      root,
      canonicalCwd,
      Date.now(),
      SESSION_REFRESH_LOOKBACK_MS
    );

    const previews = await Promise.all(
      candidates.map(async (candidate) => ({
        id: candidate.id,
        mtimeMs: candidate.mtimeMs,
        preview: await this.readSessionPreview(candidate.filePath)
      }))
    );

    return previews;
  }

  private async clearStoredSessionId(worktreeId: string): Promise<void> {
    const sessionDescriptor = this.findLatestSessionForWorktree(worktreeId);
    if (sessionDescriptor) {
      await this.store.patchSession(sessionDescriptor.id, { codexSessionId: undefined });
    }
    const running = this.sessions.get(worktreeId);
    if (running) {
      running.descriptor.codexSessionId = undefined;
      running.expectedSessionId = null;
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
    worktreeId: string,
    options: { expected?: string | null; isAutoResume: boolean }
  ): Promise<void> {
    const lookupStartedAt = Date.now();
    const sessionId = await this.locateCodexSessionId(cwd, sessionStartMs, options.expected ?? null, SESSION_CAPTURE_LOOKBACK_MS);
    if (!sessionId) {
      console.warn('[codex] unable to determine codex session id for', cwd, {
        expected: options.expected ?? null,
        autoResume: options.isAutoResume,
        elapsedMs: Date.now() - lookupStartedAt
      });
      return;
    }
    if (options.expected && options.expected !== sessionId) {
      console.warn('[codex] session id changed during capture', {
        expected: options.expected,
        resolved: sessionId,
        cwd
      });
    }
    managed.descriptor.codexSessionId = sessionId;
    managed.expectedSessionId = sessionId;
    descriptor.codexSessionId = sessionId;
    await this.store.patchSession(descriptor.id, {
      codexSessionId: sessionId
    });
    await this.store.setProjectDefaultWorktree(managed.projectId, worktreeId);
    console.log('[codex] captured session id', sessionId, 'for', cwd, {
      elapsedMs: Date.now() - lookupStartedAt
    });
  }

  private async locateCodexSessionId(
    cwd: string,
    sessionStartMs: number,
    ignoreSessionId: string | null,
    lookbackMs: number
  ): Promise<string | null> {
    const root = path.join(os.homedir(), '.codex', 'sessions');
    let canonicalCwd = cwd;
    try {
      canonicalCwd = await fs.realpath(cwd);
    } catch {
      // Ignore resolution failures; fall back to the original cwd.
    }
    const deadline = Date.now() + SESSION_ID_POLL_TIMEOUT_MS;
    let attempts = 0;

    while (Date.now() <= deadline) {
      attempts += 1;
      const candidates = await this.collectCodexSessionCandidates(root, canonicalCwd, sessionStartMs, lookbackMs);
      const match = candidates.find((candidate) => !ignoreSessionId || candidate.id !== ignoreSessionId) ?? candidates[0];
      if (match) {
        if (attempts > 1) {
          console.log('[codex] session id located after retries', {
            attempts,
            cwd,
            sessionId: match.id
          });
        }
        return match.id;
      }
      await delay(SESSION_ID_POLL_INTERVAL_MS);
    }

    console.warn('[codex] session id lookup timed out', {
      cwd,
      attempts,
      intervalMs: SESSION_ID_POLL_INTERVAL_MS,
      timeoutMs: SESSION_ID_POLL_TIMEOUT_MS
    });
    return null;
  }

  private async collectCodexSessionCandidates(
    root: string,
    cwd: string,
    sessionStartMs: number,
    lookbackMs: number
  ): Promise<Array<{ id: string; filePath: string; mtimeMs: number }>> {
    try {
      await fs.access(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const dayOffsets = [0, -1, -2, -3];
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
                if (stat.mtimeMs + lookbackMs >= sessionStartMs) {
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

    const results: Array<{ id: string; filePath: string; mtimeMs: number }> = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const meta = await this.readSessionMeta(candidate.filePath);
      if (!meta) {
        continue;
      }
      const metaCwd = meta.cwd ?? '';
      let canonicalMeta = metaCwd;
      try {
        canonicalMeta = await fs.realpath(metaCwd);
      } catch {
        // Ignore resolution failures; fall back to logged cwd.
      }
      if (canonicalMeta === cwd) {
        const id = (meta as { id?: string; payload?: { id?: string } }).id ?? meta.id;
        if (typeof id === 'string' && !seen.has(id)) {
          results.push({ id, filePath: candidate.filePath, mtimeMs: candidate.mtimeMs });
          seen.add(id);
        }
      }
    }

    return results;
  }

  private async readSessionPreview(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (!content) {
        return '';
      }
      const trimmed = content.trim();
      if (trimmed.length <= SESSION_PREVIEW_MAX_CHARS) {
        return trimmed;
      }
      return trimmed.slice(-SESSION_PREVIEW_MAX_CHARS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[codex] failed to read session preview', filePath, error);
      }
      return '';
    }
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
