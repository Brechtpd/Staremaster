import { spawn, ChildProcess } from 'node:child_process';
import type { OrchestratorEventBus } from './event-bus';
import type { WorkerRole, WorkerStatus } from '@shared/orchestrator';

interface SpawnedWorker {
  process: ChildProcess;
  status: WorkerStatus;
  worktreePath: string;
}

const DEFAULT_BIN = process.env.CODEX_ORCHESTRATOR_BIN ?? 'codex-orchestrator';

const WORKER_ARGS: Record<WorkerRole, string[]> = {
  analyst_a: ['worker', 'analyst_a'],
  analyst_b: ['worker', 'analyst_b'],
  consensus_builder: ['worker', 'consensus_builder'],
  splitter: ['worker', 'splitter'],
  implementer: ['worker', 'implementer'],
  tester: ['worker', 'tester'],
  reviewer: ['worker', 'reviewer']
};

const LOG_TAIL_LIMIT = 4000;

export class WorkerLauncher {
  private readonly workers = new Map<string, Map<WorkerRole, SpawnedWorker>>();

  constructor(private readonly bus: OrchestratorEventBus) {}

  start(worktreeId: string, worktreePath: string, roles: WorkerRole[]): WorkerStatus[] {
    const existing = this.workers.get(worktreeId) ?? new Map<WorkerRole, SpawnedWorker>();
    const statuses: WorkerStatus[] = [];
    for (const role of roles) {
      if (existing.has(role)) {
        const record = existing.get(role);
        if (record) {
          statuses.push(record.status);
        }
        continue;
      }
      const args = WORKER_ARGS[role];
      if (!args) {
        continue;
      }
      const spawned = spawn(DEFAULT_BIN, args, {
        cwd: worktreePath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const startedAt = new Date().toISOString();
      const status: WorkerStatus = {
        id: role,
        role,
        state: 'working',
        description: 'Running',
        startedAt,
        updatedAt: startedAt,
        pid: spawned.pid ?? undefined,
        logTail: ''
      };
      const record: SpawnedWorker = {
        process: spawned,
        status,
        worktreePath
      };
      existing.set(role, record);
      this.attachListeners(worktreeId, role, record);
      statuses.push(status);
    }
    this.workers.set(worktreeId, existing);
    return statuses;
  }

  stopAll(worktreeId: string): void {
    const map = this.workers.get(worktreeId);
    if (!map) {
      return;
    }
    for (const record of map.values()) {
      this.stop(record);
    }
    this.workers.delete(worktreeId);
  }

  private stop(record: SpawnedWorker): void {
    if (!record.process.killed) {
      record.process.kill();
    }
  }

  private attachListeners(worktreeId: string, role: WorkerRole, record: SpawnedWorker): void {
    const processRef = record.process;
    const updateStatus = (partial: Partial<WorkerStatus>) => {
      record.status = {
        ...record.status,
        ...partial,
        updatedAt: new Date().toISOString()
      };
      this.bus.publish({ kind: 'workers-updated', worktreeId, workers: [record.status] });
    };
    const appendLog = (chunk: string, source: 'stdout' | 'stderr') => {
      if (!chunk) {
        return;
      }
      const existing = record.status.logTail ?? '';
      const next = (existing + chunk).slice(-LOG_TAIL_LIMIT);
      record.status.logTail = next;
      updateStatus({ logTail: next });
      this.bus.publish({
        kind: 'worker-log',
        worktreeId,
        workerId: record.status.id,
        role,
        chunk,
        source,
        timestamp: new Date().toISOString()
      });
    };

    processRef.stdout?.on('data', (buffer: Buffer) => {
      appendLog(buffer.toString(), 'stdout');
    });

    processRef.stderr?.on('data', (buffer: Buffer) => {
      appendLog(buffer.toString(), 'stderr');
    });

    processRef.on('exit', (code, signal) => {
      updateStatus({
        state: 'stopped',
        description: code === 0 ? 'Exited successfully' : `Exited (${code ?? 'signal ' + signal})`,
        pid: undefined
      });
    });

    processRef.on('error', (error) => {
      const err = error as NodeJS.ErrnoException;
      const message = err.code === 'ENOENT'
        ? `Unable to spawn '${DEFAULT_BIN}'. Install codex-orchestrator or set CODEX_ORCHESTRATOR_BIN.`
        : err.message;
      appendLog(`${message}\n`, 'stderr');
      updateStatus({ state: 'error', description: message, pid: undefined });
    });
  }
}
