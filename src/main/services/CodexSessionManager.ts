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

const ANSI_ESCAPE = '\u001b';
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const RESUME_LINE_REGEX = /codex\s+resume[^\n\r]*/gi;
const MAX_RESUME_BUFFER = 512;

const stripControlCharacters = (value: string, replacement: string = ' '): string => {
  if (!value) {
    return '';
  }
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x20) {
      result += value[index];
    } else if (replacement) {
      result += replacement;
    }
  }
  return result;
};

export const detectResumeCommands = (
  state: ResumeDetectionState,
  chunk: string
): ResumeDetectionMatch[] => {
  if (!chunk) {
    return [];
  }

  const sanitizedChunk = stripControlCharacters(chunk.replace(ANSI_ESCAPE_REGEX, ''));
  if (!sanitizedChunk) {
    return [];
  }

  state.buffer += sanitizedChunk;

  const results: ResumeDetectionMatch[] = [];
  let match: RegExpExecArray | null;
  let lastConsumedIndex = 0;
  RESUME_LINE_REGEX.lastIndex = 0;

  while ((match = RESUME_LINE_REGEX.exec(state.buffer)) !== null) {
    const resumeLine = match[0];
    const codexSessionId = extractSessionIdFromResumeLine(resumeLine);
    if (!codexSessionId) {
      continue;
    }
    const command = sanitizeResumeCommand(resumeLine) ?? resumeLine.trim();
    const alreadyCaptured = state.resumeCaptured && state.resumeTarget === codexSessionId;
    results.push({ codexSessionId, command, alreadyCaptured });
    state.resumeTarget = codexSessionId;
    state.resumeCaptured = true;
    lastConsumedIndex = Math.max(lastConsumedIndex, RESUME_LINE_REGEX.lastIndex);
  }

  if (lastConsumedIndex > 0) {
    state.buffer = state.buffer.slice(lastConsumedIndex);
  } else if (state.buffer.length > MAX_RESUME_BUFFER) {
    state.buffer = state.buffer.slice(-MAX_RESUME_BUFFER);
  }

  return results;
};

const extractResumeTarget = (command?: string | null): string | null => {
  if (!command) {
    return null;
  }
  const sanitized = stripControlCharacters(command.replace(ANSI_ESCAPE_REGEX, ''), ' ');
  return extractSessionIdFromResumeLine(sanitized);
};

const SESSION_ID_FLAG_PREFIXES = ['--session', '--session-id', '--resume-id', '--yolo'];

const sanitizeSessionId = (value: string): string => {
  if (!value) {
    return '';
  }
  return stripControlCharacters(value, '')
    .replace(/^["']+/, '')
    .replace(/["'.,;:]+$/, '');
};

const sanitizeResumeCommand = (command: string): string | null => {
  const trimmed = command ? command.trim() : '';
  if (!trimmed.toLowerCase().startsWith('codex')) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  const lastIndex = parts.length - 1;
  if (lastIndex < 0) {
    return trimmed;
  }
  const sanitizedId = sanitizeSessionId(parts[lastIndex]);
  if (!sanitizedId) {
    return trimmed;
  }
  parts[lastIndex] = sanitizedId;
  return parts.join(' ');
};

const extractSessionIdFromResumeLine = (line: string): string | null => {
  if (!line) {
    return null;
  }
  const normalized = stripControlCharacters(line).replace(/\s+/g, ' ').trim();
  if (!normalized.toLowerCase().includes('codex resume')) {
    return null;
  }
  const tokens = normalized.split(' ');
  let fallback: string | null = null;

  const stripTrailing = (value: string) => sanitizeSessionId(stripControlCharacters(value, ''));
  const isSessionFlag = (flag: string) => SESSION_ID_FLAG_PREFIXES.some((prefix) => flag.startsWith(prefix));

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token.startsWith('--')) {
      const equalsIndex = token.indexOf('=');
      const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
      if (equalsIndex !== -1 && equalsIndex < token.length - 1) {
        const value = stripTrailing(token.slice(equalsIndex + 1));
        if (isSessionFlag(flag) && value) {
          return value;
        }
        if (value) {
          fallback = value;
        }
        continue;
      }
      const next = tokens[index + 1];
      if (next && !next.startsWith('--')) {
        const value = stripTrailing(next);
        if (isSessionFlag(flag) && value) {
          return value;
        }
        if (value) {
          fallback = value;
        }
      }
      continue;
    }
    const value = stripTrailing(token);
    if (value && value.toLowerCase() !== 'codex' && value.toLowerCase() !== 'resume') {
      fallback = value;
    }
  }
  return fallback;
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
  sessionWorktreeId: string;
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
    const storedResumeCommand = worktree.codexResumeCommand ?? null;
    const storedResumeTarget = extractResumeTarget(storedResumeCommand);
    const resumeTarget = previousSession?.codexSessionId ?? storedResumeTarget ?? null;
    const inferredResumeCommand = !previousSession?.codexSessionId && storedResumeCommand ? storedResumeCommand : null;
    const autoResumeCommand = resumeTarget ? `${CODEX_RESUME_TEMPLATE} ${resumeTarget}` : inferredResumeCommand;
    const isAutoResume = Boolean(autoResumeCommand) && !options?.command;
    const command = options?.command ?? autoResumeCommand ?? DEFAULT_CODEX_COMMAND;

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
        resumeCaptured: false,
        resumeTarget: resumeTarget ?? null
      },
      projectId: worktree.projectId,
      sessionWorktreeId: worktree.id
    };

    this.sessions.set(worktree.id, managed);
    await this.store.upsertSession(descriptor);
    await this.store.setProjectDefaultWorktree(worktree.projectId, worktree.id);

    if (!resumeTarget) {
      void this.captureCodexSessionId(worktree.path, descriptor, managed, startTimestamp, worktree.id).catch((error) => {
        console.warn('[codex] failed to capture session id', error);
      });
    } else {
      managed.resumeDetection.resumeCaptured = true;
    }

    const respondToCursorProbe = () => {
      child.write('\u001b[1;1R');
    };

    let promotedToRunning = false;

    const recordSessionInfo = (
      sessionId: string | null,
      resumeCommand?: string | null,
      alreadyCaptured?: boolean
    ) => {
      if (!sessionId) {
        return;
      }
      const normalizedCommand = resumeCommand ? sanitizeResumeCommand(resumeCommand) : null;
      const commandToPersist = normalizedCommand ?? `${CODEX_RESUME_TEMPLATE} ${sessionId}`;
      const seen = alreadyCaptured ?? (managed.resumeTarget === sessionId);
      managed.resumeTarget = sessionId;
      managed.descriptor.codexSessionId = sessionId;
      void this.store.patchSession(descriptor.id, {
        codexSessionId: sessionId
      });
      if (!seen && commandToPersist) {
        void this.store.updateCodexResumeCommand(worktree.id, commandToPersist);
        void this.store.updateCodexResumeCommand(`project-root:${worktree.projectId}`, commandToPersist);
        void this.store.setProjectDefaultWorktree(worktree.projectId, managed.sessionWorktreeId);
      }
    };

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
        recordSessionInfo(match.codexSessionId, match.command, match.alreadyCaptured);
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
      await this.store.setProjectDefaultWorktree(worktree.projectId, resumeCommand ? managed.sessionWorktreeId : null);

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
    await this.store.setProjectDefaultWorktree(managed.projectId, worktreeId);
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
      const historyMatch = await this.scanCodexHistory(sessionStartMs, ignoreSessionId);
      if (historyMatch) {
        return historyMatch;
      }
      await delay(SESSION_LOOKUP_DELAY_MS);
    }
    return this.scanCodexHistory(sessionStartMs, ignoreSessionId);
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

  private async scanCodexHistory(sessionStartMs: number, ignoreSessionId?: string | null): Promise<string | null> {
    const historyPath = path.join(os.homedir(), '.codex', 'history.jsonl');
    let raw: string;
    try {
      raw = await fs.readFile(historyPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    const thresholdMs = sessionStartMs - 5_000;
    let candidate: string | null = null;
    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { session_id?: unknown; ts?: unknown };
        const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
        if (!sessionId || (ignoreSessionId && sessionId === ignoreSessionId)) {
          continue;
        }
        const ts = typeof parsed.ts === 'number' ? parsed.ts : null;
        const tsMs = ts == null ? null : ts > 3_153_600_000 ? ts : ts * 1000;
        if (tsMs != null && tsMs >= thresholdMs) {
          candidate = sessionId;
          break;
        }
      } catch (error) {
        console.warn('[codex] failed to parse history entry', error);
      }
    }

    if (candidate) {
      return candidate;
    }

    for (const line of raw.split('\n').reverse()) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { session_id?: unknown };
        const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
        if (sessionId && (!ignoreSessionId || sessionId !== ignoreSessionId)) {
          return sessionId;
        }
      } catch (error) {
        console.warn('[codex] failed to parse history entry (reverse scan)', error);
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

  private async parseResumeCommandFromLog(worktreeId: string): Promise<string | null> {
    const logPath = path.join(this.logDir, `${worktreeId}.log`);
    let raw: string;
    try {
      raw = await fs.readFile(logPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    const cleaned = stripControlCharacters(raw).replace(ANSI_ESCAPE_REGEX, '');
    const matches = Array.from(cleaned.matchAll(RESUME_LINE_REGEX));
    if (matches.length === 0) {
      return null;
    }
    const lastLine = matches[matches.length - 1][0];
    return sanitizeResumeCommand(lastLine) ?? lastLine.trim();
  }

  async refreshResumeFromLogs(worktreeId?: string): Promise<void> {
    const state = this.store.getState();
    const targets = worktreeId
      ? state.worktrees.filter((worktree) => worktree.id === worktreeId)
      : state.worktrees;

    for (const worktree of targets) {
      const command = await this.parseResumeCommandFromLog(worktree.id);
      await this.store.updateCodexResumeCommand(worktree.id, command ?? null);
      await this.store.updateCodexResumeCommand(`project-root:${worktree.projectId}`, command ?? null);
      if (command) {
        await this.store.setProjectDefaultWorktree(worktree.projectId, worktree.id);
      }
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
