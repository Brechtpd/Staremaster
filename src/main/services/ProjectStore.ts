import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppState, CodexSessionDescriptor, ProjectDescriptor, WorktreeDescriptor } from '../../shared/ipc';

const DEFAULT_STATE: AppState = {
  projects: [],
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
      const legacyProjectRoot = (parsed as { projectRoot?: string | null }).projectRoot ?? null;
      const legacyCreatedAt = (parsed as { createdAt?: string }).createdAt;

      const projects: ProjectDescriptor[] = (parsed.projects ?? []).map((project) => ({
        ...project,
        createdAt: project.createdAt ?? new Date().toISOString()
      }));

      const worktrees: WorktreeDescriptor[] = (parsed.worktrees ?? []).map((worktree) => ({
        ...worktree
      }));

      if (projects.length === 0 && legacyProjectRoot) {
        const projectId = hashFromPath(legacyProjectRoot);
        const fallback: ProjectDescriptor = {
          id: projectId,
          root: legacyProjectRoot,
          name: path.basename(legacyProjectRoot),
          createdAt: legacyCreatedAt ?? new Date().toISOString()
        };
        projects.push(fallback);
        for (const worktree of worktrees) {
          if (!worktree.projectId) {
            worktree.projectId = projectId;
          }
        }
      }

      for (const worktree of worktrees) {
        if (!worktree.projectId && projects.length > 0) {
          worktree.projectId = projects[0].id;
        }
      }

      this.state = {
        ...DEFAULT_STATE,
        ...parsed,
        projects,
        worktrees,
        sessions: parsed.sessions ?? []
      };

      delete (this.state as { projectRoot?: unknown }).projectRoot;
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

  async upsertWorktree(descriptor: WorktreeDescriptor): Promise<void> {
    const existingIndex = this.state.worktrees.findIndex((item) => item.id === descriptor.id);
    if (existingIndex >= 0) {
      this.state.worktrees[existingIndex] = descriptor;
    } else {
      this.state.worktrees.push(descriptor);
    }
    await this.save();
  }

  async upsertProject(project: ProjectDescriptor): Promise<void> {
    const index = this.state.projects.findIndex((item) => item.id === project.id);
    if (index >= 0) {
      this.state.projects[index] = project;
    } else {
      this.state.projects.push(project);
    }
    await this.save();
  }

  async removeProject(projectId: string): Promise<void> {
    this.state.projects = this.state.projects.filter((item) => item.id !== projectId);
    const worktreeIds = new Set(
      this.state.worktrees.filter((item) => item.projectId === projectId).map((item) => item.id)
    );
    this.state.worktrees = this.state.worktrees.filter((item) => item.projectId !== projectId);
    this.state.sessions = this.state.sessions.filter((session) => !worktreeIds.has(session.worktreeId));
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

  async patchProject(projectId: string, patch: Partial<ProjectDescriptor>): Promise<void> {
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) {
      return;
    }
    Object.assign(project, patch);
    await this.save();
  }

  async setProjectDefaultWorktree(projectId: string, worktreeId: string | null): Promise<void> {
    await this.patchProject(projectId, { defaultWorktreeId: worktreeId ?? undefined });
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

const hashFromPath = (input: string): string => {
  return createHash('sha1').update(path.resolve(input)).digest('hex');
};
