import { parentPort } from 'node:worker_threads';
import path from 'node:path';
import { OrchestratorCoordinator } from './index';
import { OrchestratorEventBus } from './event-bus';
import { TaskStore } from './task-store';
import { OrchestratorScheduler } from './scheduler';
import { TaskClaimStore } from './task-claim-store';
import { WorkerSupervisor } from './worker-supervisor';
import { CodexCliExecutor, StubCodexExecutor } from './codex-executor';
import type {
  OrchestratorWorkerMessage,
  OrchestratorWorkerRequest,
  OrchestratorWorkerResponse
} from '@shared/orchestrator-ipc';

const port = parentPort;

if (!port) {
  throw new Error('orchestrator worker must be spawned via Worker threads');
}

const worktreePaths = new Map<string, string>();

const bus = new OrchestratorEventBus();
const taskStore = new TaskStore();
const scheduler = new OrchestratorScheduler(bus);
const claimStore = new TaskClaimStore(taskStore);
const supervisor = new WorkerSupervisor(
  bus,
  claimStore,
  () =>
    process.env.CODEX_ORCHESTRATOR_EXECUTOR === 'stub'
      ? new StubCodexExecutor()
      : new CodexCliExecutor()
);

const coordinator = new OrchestratorCoordinator(
  (worktreeId) => {
    const path = worktreePaths.get(worktreeId);
    if (!path) {
      throw new Error(`No path registered for worktree ${worktreeId}`);
    }
    return path;
  },
  {
    bus,
    taskStore,
    scheduler
  }
);

const sendResponse = (response: OrchestratorWorkerResponse) => {
  port.postMessage(response satisfies OrchestratorWorkerResponse);
};

bus.subscribe((event) => {
  port.postMessage({ type: 'event', event } as OrchestratorWorkerMessage);
});

const handleRequest = async (request: OrchestratorWorkerRequest) => {
  try {
    switch (request.type) {
      case 'get-snapshot': {
        const result = await coordinator.getSnapshot(request.worktreeId);
        sendResponse({ id: request.id, ok: true, result });
        break;
      }
      case 'start-run': {
        worktreePaths.set(request.worktreeId, request.worktreePath);
        const result = await coordinator.startRun(request.worktreeId, request.input);
        const runRoot = path.join(request.worktreePath, 'codex-runs', result.runId);
        supervisor.registerContext(request.worktreeId, {
          worktreeId: request.worktreeId,
          runId: result.runId,
          runRoot,
          options: {
            worktreePath: request.worktreePath,
            tasksRoot: path.join(runRoot, 'tasks'),
            conversationRoot: path.join(runRoot, 'conversations')
          }
        });
        if (request.input.autoStartWorkers ?? true) {
          const configs = coordinator.getWorkerConfigurations(request.worktreeId);
          coordinator.updateWorkerConfigurations(request.worktreeId, configs);
          await supervisor.configure(request.worktreeId, configs);
        }
        sendResponse({ id: request.id, ok: true, result });
        break;
      }
      case 'follow-up': {
        const result = await coordinator.submitFollowUp(request.worktreeId, request.input);
        sendResponse({ id: request.id, ok: true, result });
        break;
      }
      case 'approve-task': {
        await coordinator.approveTask(request.worktreeId, request.taskId, request.approver);
        sendResponse({ id: request.id, ok: true });
        break;
      }
      case 'comment-task': {
        await coordinator.addComment(request.worktreeId, request.input);
        sendResponse({ id: request.id, ok: true });
        break;
      }
      case 'start-workers': {
        worktreePaths.set(request.worktreeId, request.context.worktreePath);
        supervisor.registerContext(request.worktreeId, {
          worktreeId: request.worktreeId,
          runId: request.context.runId,
          runRoot: request.context.runRoot,
          options: {
            worktreePath: request.context.worktreePath,
            tasksRoot: request.context.tasksRoot,
            conversationRoot: request.context.conversationRoot
          }
        });
        const existing = coordinator.getWorkerConfigurations(request.worktreeId);
        const overrides = new Map(request.configs.map((config) => [config.role, config]));
        const merged = existing.map((config) => {
          const override = overrides.get(config.role);
          if (!override) {
            return config;
          }
          const modelPriority = (override.modelPriority ?? config.modelPriority).filter(Boolean).slice(0, 4);
          return {
            role: config.role,
            count: Math.max(0, override.count ?? config.count ?? 0),
            modelPriority: modelPriority.length > 0 ? modelPriority : config.modelPriority
          };
        });
        for (const [role, override] of overrides.entries()) {
          if (merged.find((config) => config.role === role)) {
            continue;
          }
          merged.push({
            role,
            count: Math.max(0, override.count ?? 0),
            modelPriority: (override.modelPriority ?? []).filter(Boolean).slice(0, 4)
          });
        }
        coordinator.updateWorkerConfigurations(request.worktreeId, merged);
        await supervisor.configure(request.worktreeId, merged);
        sendResponse({ id: request.id, ok: true });
        break;
      }
      case 'stop-workers': {
        {
          const current = coordinator.getWorkerConfigurations(request.worktreeId);
          const zeroConfigs = request.roles.map((role) => {
            const existing = current.find((config) => config.role === role);
            return {
              role,
              count: 0,
              modelPriority: existing?.modelPriority ?? []
            };
          });
          coordinator.updateWorkerConfigurations(request.worktreeId, zeroConfigs);
        }
        await supervisor.stopRoles(request.worktreeId, request.roles);
        sendResponse({ id: request.id, ok: true });
        break;
      }
      case 'worktree-removed': {
        coordinator.handleWorktreeRemoved(request.worktreeId);
        worktreePaths.delete(request.worktreeId);
        await supervisor.stopAll(request.worktreeId);
        sendResponse({ id: request.id, ok: true });
        break;
      }
      case 'stop-run': {
        await supervisor.stopAll(request.worktreeId);
        await coordinator.stopRun(request.worktreeId);
        sendResponse({ id: request.id, ok: true });
        break;
      }
      case 'dispose': {
        supervisor.dispose();
        coordinator.dispose();
        sendResponse({ id: request.id, ok: true });
        break;
      }
      default: {
        const neverType: never = request;
        throw new Error(`Unhandled request ${JSON.stringify(neverType)}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendResponse({ id: request.id, ok: false, error: message });
  }
};

port.on('message', (message: OrchestratorWorkerMessage) => {
  if (!message || typeof message !== 'object') {
    return;
  }
  if ('type' in message && 'id' in message) {
    void handleRequest(message as OrchestratorWorkerRequest);
  }
});

port.on('close', () => {
  try {
    coordinator.dispose();
  } catch (error) {
    console.warn('[orchestrator] dispose error', error);
  }
});
