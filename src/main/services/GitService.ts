import path from 'node:path';
import { promises as fs } from 'node:fs';
import simpleGit, { SimpleGit } from 'simple-git';
import {
  GitStatusSummary,
  GitFileChange,
  GitDiffRequest,
  GitDiffResponse
} from '@shared/ipc';

export class GitService {
  constructor(private readonly resolveWorktreePath: (worktreeId: string) => string | null) {}

  async getStatus(worktreeId: string): Promise<GitStatusSummary> {
    const repoPath = this.ensureWorktreePath(worktreeId);
    const git = this.createGit(repoPath);
    const status = await git.status();

    const files: GitFileChange[] = status.files.map((file) => {
      const working = (file as unknown as { workingTree?: string; working_dir?: string }).workingTree ??
        (file as unknown as { working_dir?: string }).working_dir ??
        '';

      return {
        path: file.path,
        displayPath: file.path,
        index: file.index.trim(),
        workingTree: working.trim()
      };
    });

    return {
      staged: files.filter((file) => file.index && file.index !== '?'),
      unstaged: files.filter((file) => file.workingTree && file.workingTree !== '?'),
      untracked: files.filter((file) => file.index === '?' || file.workingTree === '?')
    };
  }

  async getDiff(request: GitDiffRequest): Promise<GitDiffResponse> {
    const repoPath = this.ensureWorktreePath(request.worktreeId);
    const absoluteFile = path.join(repoPath, request.filePath);
    const repoRelative = request.filePath;

    const git = this.createGit(repoPath);
    const args: string[] = [];

    if (request.staged) {
      args.push('--cached');
    }

    const isTracked = await this.isTracked(git, repoRelative);
    if (!isTracked) {
      const exists = await this.exists(absoluteFile);
      if (!exists) {
        return {
          filePath: repoRelative,
          staged: request.staged ?? false,
          diff: '',
          binary: false
        };
      }
      const content = await fs.readFile(absoluteFile, 'utf8');
      const diff = this.createNewFileDiff(repoRelative, content);
      return {
        filePath: repoRelative,
        staged: request.staged ?? false,
        diff,
        binary: false
      };
    }

    const diff = await git.diff([...args, '--', repoRelative]);
    return {
      filePath: repoRelative,
      staged: request.staged ?? false,
      diff,
      binary: false
    };
  }

  private createGit(repoPath: string): SimpleGit {
    return simpleGit({ baseDir: repoPath });
  }

  private ensureWorktreePath(worktreeId: string): string {
    const resolved = this.resolveWorktreePath(worktreeId);
    if (!resolved) {
      throw new Error(`Unknown worktree ${worktreeId}`);
    }
    return resolved;
  }

  private async isTracked(git: SimpleGit, filePath: string): Promise<boolean> {
    const result = await git.raw(['ls-files', '--', filePath]);
    return result.trim().length > 0;
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  private createNewFileDiff(filePath: string, content: string): string {
    const normalized = content.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const header =
      `diff --git a/${filePath} b/${filePath}\n` +
      `new file mode 100644\n` +
      `index 0000000..1111111\n` +
      `--- /dev/null\n` +
      `+++ b/${filePath}\n` +
      `@@ -0,0 +1,${Math.max(lines.length, 1)} @@\n`;

    const body = lines.map((line) => `+${line}`).join('\n');

    return `${header}${body}\n`;
  }
}
