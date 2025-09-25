import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppState, CodexSessionDescriptor, WorktreeDescriptor } from '../../shared/ipc';

const DEFAULT_STATE: AppState = {
  projectRoot: null,
  worktrees: [],
  sessions: []
};

export class ProjectStore {
  private state: AppState = DEFAULT_STATE;
  private readonly filePath: string;
  private initialized = false;
  private readonly userDataDir: string;

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
    this.filePath = path.join(userDataDir, 'state.json');
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as AppState;
      this.state = {
        ...DEFAULT_STATE,
        ...parsed,
        worktrees: parsed.worktrees ?? [],
        sessions: parsed.sessions ?? []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to load state file', error);
      }

      this.state = { ...DEFAULT_STATE };
      await this.save();
    }

    this.initialized = true;
  }

  getState(): AppState {
    return JSON.parse(JSON.stringify(this.state)) as AppState;
  }

  async setProjectRoot(projectRoot: string): Promise<void> {
    this.state = {
      ...this.state,
      projectRoot
    };
    await this.save();
  }

  async upsertWorktree(descriptor: WorktreeDescriptor): Promise<void> {
    const existingIndex = this.state.worktrees.findIndex((item) => item.id === descriptor.id);
    if (existingIndex >= 0) {
      this.state.worktrees[existingIndex] = descriptor;
    } else {
      this.state.worktrees.push(descriptor);
    }
    await this.save();
  }

  async removeWorktree(worktreeId: string): Promise<void> {
    this.state.worktrees = this.state.worktrees.filter((item) => item.id !== worktreeId);
    this.state.sessions = this.state.sessions.filter((session) => session.worktreeId !== worktreeId);
    await this.save();
  }

  async patchWorktree(worktreeId: string, patch: Partial<WorktreeDescriptor>): Promise<void> {
    const worktree = this.state.worktrees.find((item) => item.id === worktreeId);
    if (!worktree) {
      return;
    }
    Object.assign(worktree, patch);
    await this.save();
  }

  async upsertSession(session: CodexSessionDescriptor): Promise<void> {
    const index = this.state.sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) {
      this.state.sessions[index] = session;
    } else {
      this.state.sessions.push(session);
    }
    await this.save();
  }

  async patchSession(sessionId: string, patch: Partial<CodexSessionDescriptor>): Promise<void> {
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }
    Object.assign(session, patch);
    await this.save();
  }

  async removeSession(sessionId: string): Promise<void> {
    this.state.sessions = this.state.sessions.filter((item) => item.id !== sessionId);
    await this.save();
  }

  getUserDataDir(): string {
    return this.userDataDir;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }
}
