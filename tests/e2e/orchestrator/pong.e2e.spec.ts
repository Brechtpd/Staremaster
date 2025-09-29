import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../../../src/main/orchestrator/task-store';
import { TaskClaimStore } from '../../../src/main/orchestrator/task-claim-store';
import type { ExecutionContext, ExecutionResult, ExecutionArtifact } from '../../../src/main/orchestrator/codex-executor';
import { TesterExecutor } from '../../../src/main/orchestrator/tester-executor';
import { CodexCliExecutor } from '../../../src/main/orchestrator/codex-executor';

const cargoAvailable = (() => {
  try {
    return spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

const RUN_ID = 'RUST-FIB';

const pipelineOrder = [
  'analyst_a' as const,
  'analyst_b' as const,
  'consensus_builder' as const,
  'splitter' as const,
  'implementer' as const,
  'tester' as const,
  'reviewer' as const
];

type PipelineRole = (typeof pipelineOrder)[number];

const useRealCodex = process.env.RUN_REAL_CODEX_E2E === '1';
const useRealAnalysts = useRealCodex || process.env.RUN_REAL_CODEX_ANALYST === '1';
const useRealConsensus = useRealCodex || process.env.RUN_REAL_CODEX_CONSENSUS === '1';
const useRealSplitter = useRealCodex || process.env.RUN_REAL_CODEX_SPLITTER === '1';
const useRealImplementer = useRealCodex || process.env.RUN_REAL_CODEX_IMPLEMENTER === '1';
const useRealTester = useRealCodex || process.env.RUN_REAL_CODEX_TESTER === '1';
const useRealReviewer = useRealCodex || process.env.RUN_REAL_CODEX_REVIEWER === '1';

class StaticExecutor {
  constructor(private readonly summary: string) {}

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    context.onLog(`${this.summary}\n`, 'stdout');
    return {
      summary: this.summary,
      artifacts: []
    };
  }
}

class DeterministicImplementerExecutor {
  constructor(private readonly repoPath: string) {}

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    context.onLog('Writing Rust Fibonacci implementation\n', 'stdout');
    await this.writeSources();
    const diff = await gitDiff(this.repoPath);
    return {
      summary: 'Implemented terminal Fibonacci calculator in Rust.',
      artifacts: [
        {
          path: `artifacts/${context.task.id}.diff`,
          contents: diff
        }
      ]
    };
  }

  private async writeSources(): Promise<void> {
    const srcDir = path.join(this.repoPath, 'src');
    const testsDir = path.join(this.repoPath, 'tests');
    await mkdir(testsDir, { recursive: true });
    await writeFile(path.join(srcDir, 'lib.rs'), LIB_RS, 'utf8');
    await writeFile(path.join(srcDir, 'main.rs'), MAIN_RS, 'utf8');
    await writeFile(path.join(testsDir, 'fib.rs'), TEST_RS, 'utf8');
  }
}

class CodexImplementerExecutor {
  private readonly codex = new CodexCliExecutor();

  constructor(private readonly repoPath: string, private readonly runId = RUN_ID) {}

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const augmented = {
      ...context,
      task: {
        ...context.task,
        prompt: `${context.task.prompt}\n\nYou are implementing a Rust terminal Fibonacci CLI. Respond ONLY with a minified JSON payload of the form {"summary":"...","files":[{"path":"src/lib.rs","contents":"..."}, ...]} describing the files you modified. Include full file contents. No code fences or commentary.`
      }
    } satisfies ExecutionContext;

    const codexResult = await this.codex.execute(augmented);
    const payload = parseJsonPayload(codexResult.summary) ?? parseJsonPayload(codexResult.artifacts?.[0]?.contents ?? '');
    if (!payload) {
      throw new Error('Codex implementer response was not valid JSON.');
    }

    for (const file of payload.files ?? []) {
      const absolute = path.join(this.repoPath, file.path);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, file.contents, 'utf8');
    }

    const diff = await gitDiff(this.repoPath);
    return {
      summary: payload.summary ?? codexResult.summary,
      artifacts: [
        {
          path: `artifacts/${context.task.id}.diff`,
          contents: diff
        }
      ]
    };
  }
}

class ImplementerExecutorWrapper {
  private readonly deterministic: DeterministicImplementerExecutor;
  private readonly codex: CodexImplementerExecutor;

  constructor(private readonly repoPath: string, private readonly runId = RUN_ID) {
    this.deterministic = new DeterministicImplementerExecutor(repoPath);
    this.codex = new CodexImplementerExecutor(repoPath, runId);
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    if (useRealImplementer) {
      return await this.codex.execute(context);
    }
    return await this.deterministic.execute(context);
  }
}

const LIB_RS = `pub fn fib(n: u64) -> u64 {
    match n {
        0 => 0,
        1 => 1,
        _ => fib(n - 1) + fib(n - 2),
    }
}
`;

const MAIN_RS = `use std::env;

fn main() {
    let n = env::args()
        .nth(1)
        .expect("Provide a number")
        .parse::<u64>()
        .expect("Invalid number");
    let result = pong_cli::fib(n);
    println!("{result}");
}
`;

const TEST_RS = `use pong_cli::fib;

#[test]
fn fib_sequence() {
    assert_eq!(fib(0), 0);
    assert_eq!(fib(1), 1);
    assert_eq!(fib(2), 1);
    assert_eq!(fib(5), 5);
}
`;

const runCommand = async (command: string, args: string[], cwd: string): Promise<string> => {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
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
        reject(new Error(stderr || `${command} exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
};

const gitDiff = async (cwd: string) => {
  try {
    return await runCommand('git', ['diff'], cwd);
  } catch {
    return 'diff unavailable';
  }
};

const persistArtifacts = async (
  runRoot: string,
  worktreePath: string,
  artifacts: ExecutionArtifact[]
): Promise<string[]> => {
  const results: string[] = [];
  for (const artifact of artifacts) {
    const absolute = path.join(runRoot, artifact.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, artifact.contents, 'utf8');
    results.push(path.relative(worktreePath, absolute).replace(/\\/g, '/'));
  }
  return results;
};

const parseJsonPayload = (raw: string | undefined): { summary?: string; files?: Array<{ path: string; contents: string }> } | null => {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
};

describe.skipIf(!cargoAvailable)('End-to-end orchestration — Rust Fibonacci CLI', () => {
  let tempDir: string;
  let tasksRoot: string;
  let conversationRoot: string;
  let runRoot: string;
  let store: TaskStore;
  let claims: TaskClaimStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-fib-'));
    await runCommand('git', ['init'], tempDir);
    await runCommand('cargo', ['init', '--bin', '--quiet'], tempDir);
    await writeFile(
      path.join(tempDir, 'Cargo.toml'),
      `[package]\nname = "pong_cli"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
      'utf8'
    );
    tasksRoot = path.join(tempDir, 'codex-runs', RUN_ID, 'tasks');
    conversationRoot = path.join(tempDir, 'codex-runs', RUN_ID, 'conversations');
    runRoot = path.join(tempDir, 'codex-runs', RUN_ID);
    store = new TaskStore();
    claims = new TaskClaimStore(store);
    await store.ensureAnalysisSeeds({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      description: 'Design and ship a simple terminal Fibonacci CLI in Rust.',
      guidance: 'Follow the orchestrator workflow: analysts → consensus → splitter → implementation → testing → review.'
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const expandWorkflow = async () => {
    const tasks = await store.loadTasks({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    await store.ensureWorkflowExpansion({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      runId: RUN_ID,
      tasks
    });
  };

  const runRole = async (
    role: PipelineRole,
    executor: (context: ExecutionContext) => Promise<ExecutionResult>
  ) => {
    await expandWorkflow();
    const claim = await claims.claimNext({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot,
      role
    });
    expect(claim).not.toBeNull();
    if (!claim) {
      throw new Error(`No claim for role ${role}`);
    }
    const context: ExecutionContext = {
      worktreePath: tempDir,
      runId: RUN_ID,
      task: claim.entry.record,
      role,
      onLog: (chunk, source) => {
        if (useRealCodex) {
          process.stdout.write(`[${role}:${source}] ${chunk}`);
        }
      },
      signal: new AbortController().signal
    };
    const result = await executor(context);
    const artifactPaths = await persistArtifacts(runRoot, tempDir, result.artifacts ?? []);
    await claims.markDone(claim, {
      summary: result.summary,
      artifacts: artifactPaths
    });
  };

  it(
    'walks the full orchestrator pipeline and produces a runnable Fibonacci CLI',
    async () => {
    const implementer = new ImplementerExecutorWrapper(tempDir, RUN_ID);
    const codexExecutor = new CodexCliExecutor();
    const testerExecutor = new TesterExecutor({ command: 'cargo test --quiet' });

    const executors: Record<PipelineRole, (context: ExecutionContext) => Promise<ExecutionResult>> = {
      analyst_a: (ctx) => (useRealAnalysts ? codexExecutor.execute(ctx) : new StaticExecutor('Analyst A drafted requirements.').execute(ctx)),
      analyst_b: (ctx) => (useRealAnalysts ? codexExecutor.execute(ctx) : new StaticExecutor('Analyst B provided alternative perspective.').execute(ctx)),
      consensus_builder: (ctx) => (useRealConsensus ? codexExecutor.execute(ctx) : new StaticExecutor('Consensus reconciled analyst drafts into a single spec.').execute(ctx)),
      splitter: (ctx) => (useRealSplitter ? codexExecutor.execute(ctx) : new StaticExecutor('Splitter outlined implementation/test plan.').execute(ctx)),
      implementer: (ctx) => implementer.execute(ctx),
      tester: (ctx) => (useRealTester ? codexExecutor.execute(ctx) : testerExecutor.execute(ctx)),
      reviewer: (ctx) => (useRealReviewer ? codexExecutor.execute(ctx) : new StaticExecutor('Reviewer approved the implementation.').execute(ctx))
    };

    for (const role of pipelineOrder) {
      await runRole(role, (context) => executors[role](context));
    }

    const finalTasks = await store.loadTasks({
      worktreePath: tempDir,
      tasksRoot,
      conversationRoot
    });
    const statusByRole = new Map(finalTasks.map((task) => [task.role, task.status]));
    expect(statusByRole.get('implementer')).toBe('done');
    expect(statusByRole.get('tester')).toBe('done');
    expect(statusByRole.get('reviewer')).toBe('done');

    const fib5 = await runCommand('cargo', ['run', '--quiet', '--', '5'], tempDir);
    const fib10 = await runCommand('cargo', ['run', '--quiet', '--', '10'], tempDir);
    expect(fib5.trim()).toBe('5');
    expect(fib10.trim()).toBe('55');
  },
    600_000
  );
});
