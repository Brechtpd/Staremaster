import type {
  OrchestratorBriefingInput,
  OrchestratorCommentInput,
  OrchestratorEvent,
  OrchestratorFollowUpInput,
  OrchestratorRunSummary,
  OrchestratorSnapshot,
  WorkerRole
} from './orchestrator';
import type { WorkerSpawnConfig } from './orchestrator-config';

export interface WorkerContextPayload {
  worktreePath: string;
  runId: string;
  runRoot: string;
  tasksRoot: string;
  conversationRoot: string;
}

export type OrchestratorWorkerRequest =
  | {
      id: string;
      type: 'get-snapshot';
      worktreeId: string;
    }
  | {
      id: string;
      type: 'start-run';
      worktreeId: string;
      worktreePath: string;
      input: OrchestratorBriefingInput;
    }
  | {
      id: string;
      type: 'follow-up';
      worktreeId: string;
      input: OrchestratorFollowUpInput;
    }
  | {
      id: string;
      type: 'approve-task';
      worktreeId: string;
      taskId: string;
      approver: string;
    }
  | {
      id: string;
      type: 'comment-task';
      worktreeId: string;
      input: OrchestratorCommentInput;
    }
  | {
      id: string;
      type: 'worktree-removed';
      worktreeId: string;
    }
  | {
      id: string;
      type: 'start-workers';
      worktreeId: string;
      configs: WorkerSpawnConfig[];
      context: WorkerContextPayload;
    }
  | {
      id: string;
      type: 'stop-workers';
      worktreeId: string;
      roles: WorkerRole[];
    }
  | {
      id: string;
      type: 'dispose';
    };

export type OrchestratorWorkerResponse =
  | {
      id: string;
      ok: true;
      result?: OrchestratorRunSummary | OrchestratorSnapshot | null;
    }
  | {
      id: string;
      ok: false;
      error: string;
    };

export type OrchestratorWorkerEvent = {
  type: 'event';
  event: OrchestratorEvent;
};

export type OrchestratorWorkerMessage = OrchestratorWorkerRequest | OrchestratorWorkerResponse | OrchestratorWorkerEvent;
