import { spawn } from 'node:child_process';
import path from 'node:path';
import type { CodexExecutor, ExecutionContext, ExecutionResult } from './codex-executor';

export interface TesterExecutorOptions {
  command?: string;
  shell?: string;
}

export class TesterExecutor implements CodexExecutor {
  private readonly command: string;
  private readonly shell: string;

  constructor(options: TesterExecutorOptions = {}) {
    this.command = options.command ?? process.env.CODEX_TEST_COMMAND ?? 'npm test';
    this.shell = options.shell ?? process.env.SHELL ?? '/bin/bash';
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const cwd = context.task.cwd && context.task.cwd !== '.'
      ? path.join(context.worktreePath, context.task.cwd)
      : context.worktreePath;
    const command = this.command.trim();
    if (!command) {
      throw new Error('No test command configured');
    }

    return await new Promise<ExecutionResult>((resolve, reject) => {
      const child = spawn(this.shell, ['-lc', command], {
        cwd,
        env: this.buildEnv(context)
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
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Test command failed with exit code ${code}`));
          return;
        }
        const summary = `Test command succeeded: ${command}`;
        resolve({
          summary,
          artifacts: [
            {
              path: `artifacts/${context.task.id}.log`,
              contents: stdout || 'Tests produced no output.'
            }
          ]
        });
      });
    });
  }

  private buildEnv(context: ExecutionContext): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_ORCHESTRATOR_ROLE: context.role,
      CODEX_ORCHESTRATOR_TASK_ID: context.task.id,
      CODEX_ORCHESTRATOR_RUN_ID: context.runId
    };
    if (!env.CODEX_THINKING_MODE) {
      env.CODEX_THINKING_MODE = 'low';
    }
    if (!env.CODEX_COMPLEXITY) {
      env.CODEX_COMPLEXITY = 'low';
    }
    if (!env.CODEX_REASONING_EFFORT) {
      env.CODEX_REASONING_EFFORT = 'low';
    }
    return env;
  }
}
