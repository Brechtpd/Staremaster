export type WorkerRole =
  | 'analyst_a'
  | 'analyst_b'
  | 'consensus_builder'
  | 'implementer'
  | 'tester'
  | 'reviewer'
  | 'splitter';

export type AgentGraphNodeState = 'idle' | 'pending' | 'active' | 'done' | 'error';

export type TaskKind = 'analysis' | 'consensus' | 'impl' | 'test' | 'review';

export type WorkerOutcomeStatus = 'ok' | 'changes_requested' | 'blocked';

export interface WorkerOutcomeDocument {
  status: WorkerOutcomeStatus;
  summary: string;
  details?: string;
  documentPath?: string;
}

export type TaskStatus =
  | 'ready'
  | 'in_progress'
  | 'awaiting_review'
  | 'changes_requested'
  | 'approved'
  | 'blocked'
  | 'done'
  | 'error';

export interface TaskRecord {
  id: string;
  epicId: string;
  kind: TaskKind;
  role: WorkerRole;
  title: string;
  prompt: string;
  status: TaskStatus;
  cwd: string;
  dependsOn: string[];
  approvalsRequired: number;
  approvals: string[];
  artifacts: string[];
  conversationPath?: string;
  summary?: string;
  workerOutcome?: WorkerOutcomeDocument;
  assignee?: string;
  lastClaimedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkerState = 'idle' | 'claiming' | 'working' | 'waiting' | 'stopped' | 'error';

export interface WorkerStatus {
  id: string;
  role: WorkerRole;
  state: WorkerState;
  taskId?: string;
  description?: string;
  lastHeartbeatAt?: string;
  startedAt?: string;
  updatedAt: string;
  pid?: number;
  logTail?: string;
  model?: string;
  reasoningDepth?: string;
}

export type OrchestratorRunStatus =
  | 'idle'
  | 'bootstrapping'
  | 'running'
  | 'awaiting_follow_up'
  | 'completed'
  | 'error';

export type OrchestratorRunMode = 'implement_feature' | 'bug_hunt';

export interface OrchestratorRunSummary {
  worktreeId: string;
  runId: string;
  epicId: string | null;
  status: OrchestratorRunStatus;
  description: string;
  guidance?: string;
  mode: OrchestratorRunMode;
  bugHunterCount?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

export interface OrchestratorSnapshot {
  run: OrchestratorRunSummary;
  tasks: TaskRecord[];
  workers: WorkerStatus[];
  lastEventAt?: string;
  metadata?: {
    implementerLockHeldBy: string | null;
    workerCounts: Partial<Record<WorkerRole, number>>;
    modelPriority: Partial<Record<WorkerRole, string[]>>;
    agentStates?: Partial<Record<WorkerRole, AgentGraphNodeState>>;
    mode?: OrchestratorRunMode;
    bugHunterCount?: number;
  };
}

export interface OrchestratorBriefingInput {
  description: string;
  guidance?: string;
  autoStartWorkers?: boolean;
  mode?: OrchestratorRunMode;
  bugHunterCount?: number;
  initialWorkerCounts?: Partial<Record<WorkerRole, number>>;
}

export interface OrchestratorFollowUpInput {
  description: string;
  guidance?: string;
}

export interface OrchestratorCommentInput {
  taskId: string;
  author: string;
  message: string;
}

export interface ConversationEntry {
  id: string;
  taskId: string;
  author: string;
  message: string;
  createdAt: string;
}

export type OrchestratorEvent =
  | {
      kind: 'snapshot';
      worktreeId: string;
      snapshot: OrchestratorSnapshot | null;
    }
  | {
      kind: 'run-status';
      worktreeId: string;
      run: OrchestratorRunSummary;
    }
  | {
      kind: 'tasks-updated';
      worktreeId: string;
      tasks: TaskRecord[];
    }
  | {
      kind: 'tasks-removed';
      worktreeId: string;
      taskIds: string[];
    }
  | {
      kind: 'workers-updated';
      worktreeId: string;
      workers: WorkerStatus[];
    }
  | {
      kind: 'worker-log';
      worktreeId: string;
      workerId: string;
      role: WorkerRole;
      chunk: string;
      source: 'stdout' | 'stderr';
      timestamp: string;
    }
  | {
      kind: 'conversation-appended';
      worktreeId: string;
      entry: ConversationEntry;
    }
  | {
      kind: 'error';
      worktreeId: string;
      message: string;
      occurredAt: string;
    };
