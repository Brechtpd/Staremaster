import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodexExecutor, ExecutionContext, ExecutionResult } from './codex-executor';

export interface ImplementerExecutorOptions {
  codexBin?: string;
  lockPath?: string;
}

export class ImplementerExecutor implements CodexExecutor {
  private readonly codexBin: string;
  private readonly lockPath?: string;

  constructor(options: ImplementerExecutorOptions = {}) {
    this.codexBin = options.codexBin ?? process.env.CODEX_BIN ?? 'codex';
    this.lockPath = options.lockPath;
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    if (this.lockPath) {
      await this.acquireLock(context);
    }
    try {
      return await this.runPatch(context);
    } finally {
      if (this.lockPath) {
        await this.releaseLock();
      }
    }
  }

  private async runPatch(context: ExecutionContext): Promise<ExecutionResult> {
    const cwd = this.resolveCwd(context);
    const args = ['patch', '--apply', '--yolo', '--sandbox-mode', 'workspace-write'];
    return await new Promise<ExecutionResult>((resolve, reject) => {
      const env = {
        ...process.env,
        CODEX_ORCHESTRATOR_ROLE: context.role,
        CODEX_ORCHESTRATOR_TASK_ID: context.task.id,
        CODEX_ORCHESTRATOR_RUN_ID: context.runId,
        CODEX_SANDBOX_MODE: 'workspace-write'
      } as NodeJS.ProcessEnv;

      if (!env.CODEX_THINKING_MODE) {
        env.CODEX_THINKING_MODE = 'low';
      }
      if (!env.CODEX_COMPLEXITY) {
        env.CODEX_COMPLEXITY = 'low';
      }
      if (!env.CODEX_REASONING_EFFORT) {
        env.CODEX_REASONING_EFFORT = 'low';
      }
      if (!env.CODEX_UNSAFE_ALLOW_NO_SANDBOX) {
        env.CODEX_UNSAFE_ALLOW_NO_SANDBOX = '1';
      }

      const child = spawn(this.codexBin, args, {
        cwd,
        env
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        context.onLog(chunk, 'stdout');
      });

      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        context.onLog(chunk, 'stderr');
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', async (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `codex patch exited with ${code}`));
          return;
        }
        try {
          const diff = await this.captureDiff(cwd);
          const summary = stdout.trim() || 'Applied implementation changes.';
          resolve({
            summary,
            artifacts: [
              {
                path: `artifacts/${context.task.id}.diff`,
                contents: diff
              }
            ]
          });
        } catch (error) {
          reject(error);
        }
      });

      if (child.stdin) {
        child.stdin.setDefaultEncoding('utf8');
        child.stdin.write(context.task.prompt);
        child.stdin.end();
      }
    });
  }

  private async captureDiff(cwd: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['diff'], { cwd });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `git diff exited with code ${code}`));
          return;
        }
        resolve(stdout || 'No changes produced by implementer task.');
      });
    });
  }

  private resolveCwd(context: ExecutionContext): string {
    return context.task.cwd && context.task.cwd !== '.'
      ? path.join(context.worktreePath, context.task.cwd)
      : context.worktreePath;
  }

  private async acquireLock(context: ExecutionContext): Promise<void> {
    if (!this.lockPath) {
      return;
    }
    const lockDir = path.dirname(this.lockPath);
    await fs.mkdir(lockDir, { recursive: true });
    try {
      await fs.writeFile(this.lockPath, context.task.id, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Implementer workspace is locked by another task');
      }
      throw error;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockPath) {
      return;
    }
    await fs.rm(this.lockPath, { force: true });
  }
}
