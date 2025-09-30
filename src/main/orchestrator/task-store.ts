import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import type {
  ConversationEntry,
  OrchestratorCommentInput,
  OrchestratorRunMode,
  TaskRecord,
  TaskStatus,
  TaskKind,
  WorkerRole
} from '@shared/orchestrator';

const TASK_DIRECTORIES = ['analysis', 'consensus', 'impl', 'test', 'review', 'done', 'backlog'] as const;

type TaskDirectory = (typeof TASK_DIRECTORIES)[number];

export interface LoadTaskOptions {
  worktreePath: string;
  tasksRoot: string;
  conversationRoot: string;
}

export interface TaskEntry {
  record: TaskRecord;
  filePath: string;
  directory: TaskDirectory;
}

interface TaskSeed {
  id: string;
  epic: string | null;
  kind: TaskKind;
  role: WorkerRole;
  title: string;
  prompt: string;
  status: TaskStatus;
  cwd: string;
  depends_on: string[];
  approvals_required: number;
  approvals: string[];
  artifacts: string[];
}

const ensurePosix = (value: string): string => value.replace(/\\/g, '/');

const isTaskStatus = (value: unknown): value is TaskStatus =>
  typeof value === 'string' &&
  [
    'ready',
    'in_progress',
    'awaiting_review',
    'changes_requested',
    'approved',
    'blocked',
    'done',
    'error'
  ].includes(value);

const isTaskKind = (value: unknown): value is TaskKind =>
  typeof value === 'string' && ['analysis', 'consensus', 'impl', 'test', 'review'].includes(value);

const isWorkerRole = (value: unknown): value is WorkerRole =>
  typeof value === 'string' &&
  ['analyst_a', 'analyst_b', 'consensus_builder', 'implementer', 'tester', 'reviewer', 'splitter'].includes(value);

const readString = (object: Record<string, unknown>, key: string): string | null => {
  const value = object[key];
  return typeof value === 'string' ? value : null;
};

const readNumber = (object: Record<string, unknown>, key: string): number | null => {
  const value = object[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const readStringArray = (object: Record<string, unknown>, key: string): string[] => {
  const value = object[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
};

export class TaskStore {
  async loadTasks(options: LoadTaskOptions): Promise<TaskRecord[]> {
    if (!(await this.exists(options.tasksRoot))) {
      return [];
    }
    const entries = await this.readTaskEntries(options);
    return entries.map((entry) => entry.record);
  }

  async watchTasks(
    worktreeId: string,
    options: LoadTaskOptions,
    onChange: (tasks: TaskRecord[]) => void | Promise<void>
  ): Promise<() => Promise<void>> {
    const emitSnapshot = async () => {
      const records = await this.loadTasks(options);
      await onChange(records);
    };

    await emitSnapshot();

    if (!(await this.exists(options.tasksRoot))) {
      return async () => undefined;
    }

    const { watcher, cancelDebounce } = this.createWatcher(options.tasksRoot, worktreeId, emitSnapshot);
    return async () => {
      cancelDebounce();
      try {
        await watcher.close();
      } catch (error) {
        console.warn('[orchestrator] failed to close task watcher', {
          worktreeId,
          message: (error as Error).message
        });
      }
    };
  }

  async approveTask(params: {
    worktreePath: string;
    tasksRoot: string;
    conversationRoot: string;
    taskId: string;
    approver: string;
  }): Promise<TaskRecord | null> {
    const result = await this.withTaskPayload(
      params.worktreePath,
      params.tasksRoot,
      params.conversationRoot,
      params.taskId,
      async (payload, meta) => {
        const approvals = Array.isArray(payload.approvals)
          ? payload.approvals.filter((value): value is string => typeof value === 'string')
          : [];
        if (approvals.includes(params.approver)) {
          return this.toTaskRecord(payload, meta);
        }
        approvals.push(params.approver);
        payload.approvals = approvals;
        payload.updated_at = new Date().toISOString();
        await this.writeTaskFile(meta.filePath, payload);
        return this.toTaskRecord(payload, meta);
      }
    );
    return result ? result.record : null;
  }

  async appendConversationEntry(params: {
    worktreePath: string;
    conversationRoot: string;
    taskId: string;
    input: OrchestratorCommentInput;
  }): Promise<ConversationEntry> {
    const now = new Date().toISOString();
    const entry: ConversationEntry = {
      id: randomUUID(),
      taskId: params.taskId,
      author: params.input.author,
      message: params.input.message,
      createdAt: now
    };
    await fs.mkdir(params.conversationRoot, { recursive: true });
    const filePath = path.join(params.conversationRoot, `${params.taskId}.md`);
    const serialized = `### ${entry.createdAt} — ${entry.author}\n\n${entry.message}\n\n`;
    await fs.appendFile(filePath, serialized, 'utf8');
    return entry;
  }

  async ensureAnalysisSeeds(params: {
    worktreePath: string;
    tasksRoot: string;
    conversationRoot: string;
    runId: string;
    description: string;
    guidance?: string;
    epicId?: string | null;
    analysisCount?: number;
  }): Promise<TaskRecord[]> {
    const analysisRoot = path.join(params.tasksRoot, 'analysis');
    await fs.mkdir(analysisRoot, { recursive: true });
    const buckets: Array<{ role: WorkerRole; title: string }> = [
      { role: 'analyst_a', title: 'Analyst A — requirements draft' },
      { role: 'analyst_b', title: 'Analyst B — requirements draft' }
    ];
    const targetCount = Math.max(1, Math.min(params.analysisCount ?? buckets.length, buckets.length));
    const created: TaskRecord[] = [];
    const now = new Date().toISOString();
    for (const bucket of buckets.slice(0, targetCount)) {
      const suffix = bucket.role === 'analyst_a' ? 'A' : 'B';
      const taskId = `ANALYSIS-${params.runId}-${suffix}`;
      const fileName = `${taskId}.json`;
      const filePath = path.join(analysisRoot, fileName);
      if (await this.exists(filePath)) {
        continue;
      }
      const prompt = this.buildAnalysisPrompt({
        role: bucket.role,
        description: params.description,
        guidance: params.guidance
      });
      const payload = {
        id: taskId,
        epic: params.epicId ?? params.runId,
        kind: 'analysis',
        role: bucket.role,
        title: bucket.title,
        prompt,
        status: 'ready',
        cwd: '.',
        depends_on: [],
        approvals_required: 0,
        approvals: [],
        artifacts: [],
        created_at: now,
        updated_at: now
      } as Record<string, unknown>;
      await this.writeTaskFile(filePath, payload);
      const record = this.toTaskRecord(payload, {
        worktreePath: params.worktreePath,
        fileName,
        directory: 'analysis',
        filePath,
        tasksRoot: params.tasksRoot,
        conversationRoot: params.conversationRoot
      });
      if (record) {
        created.push(record.record);
      }
    }
    return created;
  }

  async ensureBugHuntSeeds(params: {
    worktreePath: string;
    tasksRoot: string;
    conversationRoot: string;
    runId: string;
    description: string;
    guidance?: string;
    bugHunterCount: number;
  }): Promise<TaskRecord[]> {
    const hunters = Math.max(1, Math.floor(params.bugHunterCount));
    const created: TaskRecord[] = [];
    const roleSequence: WorkerRole[] = ['analyst_a', 'analyst_b'];

    for (let index = 0; index < hunters; index += 1) {
      const role = roleSequence[index % roleSequence.length];
      const hunterNumber = index + 1;
      const id = `BUGHUNT-${params.runId}-${hunterNumber}`;
      const prompt = this.buildBugHunterPrompt({
        runId: params.runId,
        description: params.description,
        guidance: params.guidance,
        hunterNumber,
        totalHunters: hunters
      });
      const record = await this.writeTaskIfMissing({
        directory: 'analysis',
        tasksRoot: params.tasksRoot,
        worktreePath: params.worktreePath,
        conversationRoot: params.conversationRoot,
        payload: {
          id,
          epic: params.runId,
          kind: 'analysis',
          role,
          title: `Bug hunter ${hunterNumber} — investigate`,
          prompt,
          status: 'ready',
          cwd: '.',
          depends_on: [],
          approvals_required: 0,
          approvals: [],
          artifacts: []
        }
      });
      if (record) {
        created.push(record);
      }
    }

    return created;
  }

  async ensureWorkflowExpansion(params: {
    worktreePath: string;
    tasksRoot: string;
    conversationRoot: string;
    runId: string;
    tasks: TaskRecord[];
    description?: string;
    guidance?: string;
    mode?: OrchestratorRunMode;
    bugHunterCount?: number;
    analysisCount?: number;
  }): Promise<TaskRecord[]> {
    let workingTasks = params.tasks.slice();

    const reloadTasks = async () => {
      workingTasks = await this.loadTasks({
        worktreePath: params.worktreePath,
        tasksRoot: params.tasksRoot,
        conversationRoot: params.conversationRoot
      });
    };

    if (
      await this.applyReviewFeedback({
        worktreePath: params.worktreePath,
        tasksRoot: params.tasksRoot,
        conversationRoot: params.conversationRoot,
        tasks: workingTasks
      })
    ) {
      await reloadTasks();
    }

    const ensure = async (
      producer: (tasks: TaskRecord[]) => Promise<TaskRecord[] | TaskRecord | null>
    ): Promise<void> => {
      const result = await producer(workingTasks);
      if (!result) {
        return;
      }
      const list = Array.isArray(result) ? result : [result];
      if (list.length === 0) {
        return;
      }
      workingTasks = workingTasks.concat(list);
    };

    await ensure((tasks) =>
      this.ensureConsensusTask({
        ...params,
        tasks
      })
    );

    await ensure((tasks) =>
      this.ensureSplitterTask({
        ...params,
        tasks
      })
    );

    await ensure((tasks) =>
      this.ensureImplementationTasks({
        ...params,
        tasks
      })
    );

    return workingTasks;
  }

  async readTaskEntries(options: LoadTaskOptions): Promise<TaskEntry[]> {
    const entries: TaskEntry[] = [];
    for (const directory of TASK_DIRECTORIES) {
      const directoryPath = path.join(options.tasksRoot, directory);
      const directoryEntries = await this.loadDirectory(directoryPath, options, directory);
      entries.push(...directoryEntries);
    }
    return entries;
  }

  private async ensureConsensusTask(params: {
    worktreePath: string;
    tasksRoot: string;
    conversationRoot: string;
    runId: string;
    tasks: TaskRecord[];
    description?: string;
    guidance?: string;
    mode?: OrchestratorRunMode;
    bugHunterCount?: number;
    analysisCount?: number;
  }): Promise<TaskRecord | null> {
    const existing = params.tasks.find((task) => task.kind === 'consensus');
    const analysesDone = params.tasks.filter((task) => task.kind === 'analysis' && task.status === 'done');
    const totalAnalyses = params.tasks.filter((task) => task.kind === 'analysis').length;
    if (totalAnalyses === 0) {
      return null;
    }
    const expectedAnalyses =
      params.mode === 'bug_hunt'
        ? Math.max(1, params.bugHunterCount ?? params.analysisCount ?? totalAnalyses)
        : Math.max(1, params.analysisCount ?? totalAnalyses);
    const requiredAnalyses = Math.min(expectedAnalyses, totalAnalyses);
    if (existing || analysesDone.length < requiredAnalyses) {
      return null;
    }
    const consensusId = `CONSENSUS-${params.runId}`;
    const dependsOn = analysesDone.map((task) => task.id);
    const prompt = this.buildConsensusPrompt({
      runId: params.runId,
      mode: params.mode ?? 'implement_feature',
      description: params.description,
      guidance: params.guidance
    });
    const title =
      (params.mode ?? 'implement_feature') === 'bug_hunt'
        ? 'Consensus — document bug and proposed fix'
        : 'Consensus — unify analyst drafts';
    return await this.writeTaskIfMissing({
      directory: 'consensus',
      tasksRoot: params.tasksRoot,
      worktreePath: params.worktreePath,
      conversationRoot: params.conversationRoot,
      payload: {
        id: consensusId,
        epic: params.runId,
        kind: 'consensus',
        role: 'consensus_builder',
        title,
        prompt,
        status: 'ready',
        cwd: '.',
        depends_on: dependsOn,
        approvals_required: 0,
        approvals: [],
        artifacts: []
      }
    });
  }

  private async ensureSplitterTask(params: {
    worktreePath: string;
    tasksRoot: string;
    conversationRoot: string;
    runId: string;
    tasks: TaskRecord[];
    description?: string;
    guidance?: string;
    mode?: OrchestratorRunMode;
    analysisCount?: number;
  }): Promise<TaskRecord | null> {
    const existing = params.tasks.find((task) => task.role === 'splitter');
    const consensus = params.tasks.find((task) => task.kind === 'consensus' && task.status === 'done');
    if (existing || !consensus) {
      return null;
    }
    const splitterId = `SPLIT-${params.runId}`;
    const prompt = this.buildSplitterPrompt({
      runId: params.runId,
      mode: params.mode ?? 'implement_feature',
      description: params.description,
      guidance: params.guidance
    });
    const title =
      (params.mode ?? 'implement_feature') === 'bug_hunt'
        ? 'Fix planner — remediation plan'
        : 'Splitter — implementation plan';
    return await this.writeTaskIfMissing({
      directory: 'analysis',
      tasksRoot: params.tasksRoot,
      worktreePath: params.worktreePath,
      conversationRoot: params.conversationRoot,
      payload: {
        id: splitterId,
        epic: params.runId,
        kind: 'analysis',
        role: 'splitter',
        title,
        prompt,
        status: 'ready',
        cwd: '.',
        depends_on: [consensus.id],
        approvals_required: 0,
        approvals: [],
        artifacts: []
      }
    });
  }

  private async ensureImplementationTasks(params: {
    worktreePath: string;
    tasksRoot: string;
    conversationRoot: string;
    runId: string;
    tasks: TaskRecord[];
    description?: string;
    guidance?: string;
    mode?: OrchestratorRunMode;
  }): Promise<TaskRecord[] | null> {
    const splitter = params.tasks.find((task) => task.role === 'splitter' && task.status === 'done');
    if (!splitter) {
      return null;
    }
    const implementerId = `IMPL-${params.runId}`;
    const testerId = `TEST-${params.runId}`;
    const reviewerId = `REVIEW-${params.runId}`;

    const alreadyCreated = params.tasks.some((task) => task.id === implementerId);
    if (alreadyCreated) {
      return null;
    }

    const created: TaskRecord[] = [];
    const implementer = await this.writeTaskIfMissing({
      directory: 'impl',
      tasksRoot: params.tasksRoot,
      worktreePath: params.worktreePath,
      conversationRoot: params.conversationRoot,
      payload: {
        id: implementerId,
        epic: params.runId,
        kind: 'impl',
        role: 'implementer',
        title:
          (params.mode ?? 'implement_feature') === 'bug_hunt'
            ? 'Implementer — apply the bug fix'
            : 'Implementer — apply plan in code',
        prompt: this.buildImplementerPrompt({
          runId: params.runId,
          mode: params.mode ?? 'implement_feature',
          description: params.description,
          guidance: params.guidance
        }),
        status: 'ready',
        cwd: '.',
        depends_on: [splitter.id],
        approvals_required: 0,
        approvals: [],
        artifacts: []
      }
    });
    if (implementer) {
      created.push(implementer);
    }

    const tester = await this.writeTaskIfMissing({
      directory: 'test',
      tasksRoot: params.tasksRoot,
      worktreePath: params.worktreePath,
      conversationRoot: params.conversationRoot,
      payload: {
        id: testerId,
        epic: params.runId,
        kind: 'test',
        role: 'tester',
        title:
          (params.mode ?? 'implement_feature') === 'bug_hunt'
            ? 'Tester — confirm bug is resolved'
            : 'Tester — validate build and behaviour',
        prompt: this.buildTesterPrompt({
          runId: params.runId,
          mode: params.mode ?? 'implement_feature',
          description: params.description,
          guidance: params.guidance
        }),
        status: 'ready',
        cwd: '.',
        depends_on: [implementerId],
        approvals_required: 0,
        approvals: [],
        artifacts: []
      }
    });
    if (tester) {
      created.push(tester);
    }

    const reviewer = await this.writeTaskIfMissing({
      directory: 'review',
      tasksRoot: params.tasksRoot,
      worktreePath: params.worktreePath,
      conversationRoot: params.conversationRoot,
      payload: {
        id: reviewerId,
        epic: params.runId,
        kind: 'review',
        role: 'reviewer',
        title:
          (params.mode ?? 'implement_feature') === 'bug_hunt'
            ? 'Reviewer — finalise bug fix'
            : 'Reviewer — assess implementation',
        prompt: this.buildReviewerPrompt({
          runId: params.runId,
          mode: params.mode ?? 'implement_feature',
          description: params.description,
          guidance: params.guidance
        }),
        status: 'ready',
        cwd: '.',
        depends_on: [implementerId, testerId],
        approvals_required: 1,
        approvals: [],
        artifacts: []
      }
    });
    if (reviewer) {
      created.push(reviewer);
    }

    return created;
  }

  private async applyReviewFeedback(params: {
    worktreePath: string;
    tasksRoot: string;
    conversationRoot: string;
    tasks: TaskRecord[];
  }): Promise<boolean> {
    let mutated = false;
    for (const task of params.tasks) {
      if (task.kind !== 'review' || task.status !== 'changes_requested') {
        continue;
      }
      if (
        await this.reopenTasksForReview({
          worktreePath: params.worktreePath,
          tasksRoot: params.tasksRoot,
          conversationRoot: params.conversationRoot,
          review: task
        })
      ) {
        mutated = true;
      }
    }
    return mutated;
  }

  private async reopenTasksForReview(params: {
    worktreePath: string;
    tasksRoot: string;
    conversationRoot: string;
    review: TaskRecord;
  }): Promise<boolean> {
    let mutated = false;
    const now = new Date().toISOString();
    const resetTask = async (taskId: string): Promise<void> => {
      const updated = await this.withTaskPayload(
        params.worktreePath,
        params.tasksRoot,
        params.conversationRoot,
        taskId,
        async (payload, meta) => {
          const currentStatus = typeof payload.status === 'string' ? payload.status : undefined;
          if (currentStatus === 'ready' || currentStatus === 'in_progress') {
            return null;
          }
          payload.status = 'ready';
          if (Array.isArray(payload.approvals) && payload.approvals.length > 0) {
            payload.approvals = [];
          }
          if ('last_claimed_by' in payload) {
            delete payload.last_claimed_by;
          }
          payload.updated_at = now;
          await this.writeTaskFile(meta.filePath, payload);
          return this.toTaskRecord(payload, meta);
        }
      );
      if (updated) {
        mutated = true;
      }
    };

    for (const dependencyId of params.review.dependsOn ?? []) {
      await resetTask(dependencyId);
    }

    const reviewReset = await this.withTaskPayload(
      params.worktreePath,
      params.tasksRoot,
      params.conversationRoot,
      params.review.id,
      async (payload, meta) => {
        if (payload.status === 'ready') {
          return null;
        }
        payload.status = 'ready';
        if (Array.isArray(payload.approvals) && payload.approvals.length > 0) {
          payload.approvals = [];
        }
        if ('last_claimed_by' in payload) {
          delete payload.last_claimed_by;
        }
        payload.updated_at = now;
        await this.writeTaskFile(meta.filePath, payload);
        return this.toTaskRecord(payload, meta);
      }
    );

    if (reviewReset) {
      mutated = true;
    }

    return mutated;
  }

  private async writeTaskIfMissing(params: {
    directory: TaskDirectory;
    tasksRoot: string;
    worktreePath: string;
    conversationRoot: string;
    payload: TaskSeed;
  }): Promise<TaskRecord | null> {
    const now = new Date().toISOString();
    const directoryPath = path.join(params.tasksRoot, params.directory);
    await fs.mkdir(directoryPath, { recursive: true });
    const filePath = path.join(directoryPath, `${params.payload.id}.json`);
    if (await this.exists(filePath)) {
      return null;
    }
    const filePayload = {
      ...params.payload,
      created_at: now,
      updated_at: now
    } as Record<string, unknown>;
    await this.writeTaskFile(filePath, filePayload);
    const record = this.toTaskRecord(filePayload, {
      worktreePath: params.worktreePath,
      fileName: `${params.payload.id}.json`,
      directory: params.directory,
      filePath,
      tasksRoot: params.tasksRoot,
      conversationRoot: params.conversationRoot
    });
    return record?.record ?? null;
  }

  private buildRunContextSuffix(description?: string, guidance?: string): string {
    const segments: string[] = [];
    const trimmedDescription = description?.trim();
    const trimmedGuidance = guidance?.trim();
    if (trimmedDescription) {
      segments.push(`Run context: ${trimmedDescription}`);
    }
    if (trimmedGuidance) {
      segments.push(`Additional guidance: ${trimmedGuidance}`);
    }
    return segments.length > 0 ? `\n\n${segments.join('\n')}` : '';
  }

  private buildBugHunterPrompt(context: {
    runId: string;
    description: string;
    guidance?: string;
    hunterNumber: number;
    totalHunters: number;
  }): string {
    const teammatesNote =
      context.totalHunters > 1
        ? `Coordinate with the other ${context.totalHunters - 1} bug hunter${context.totalHunters - 1 === 1 ? '' : 's'} by sharing interim findings so the team can converge quickly.`
        : 'Document your reasoning clearly so downstream teammates can understand the failure without additional context.';
    return `You are Bug Hunter #${context.hunterNumber} for run ${context.runId}. Reproduce the reported defect, inspect the code to isolate the root cause, and propose the minimal fix or mitigation. Capture logs, relevant files, and assumptions in your notes. ${teammatesNote}${this.buildRunContextSuffix(context.description, context.guidance)}`;
  }

  private buildConsensusPrompt(context: {
    runId: string;
    mode: OrchestratorRunMode;
    description?: string;
    guidance?: string;
  }): string {
    if (context.mode === 'bug_hunt') {
      return `Synthesise every bug-hunter investigation for run ${context.runId}. Provide a precise explanation of the defect (root cause, affected components, reproduction steps) and agree on the fix approach the team should follow.${this.buildRunContextSuffix(context.description, context.guidance)}`;
    }
    return `You are the consensus builder for run ${context.runId}. Read Analyst A and Analyst B drafts, reconcile differences, and produce a single set of actionable requirements plus acceptance criteria.${this.buildRunContextSuffix(context.description, context.guidance)}`;
  }

  private buildSplitterPrompt(context: {
    runId: string;
    mode: OrchestratorRunMode;
    description?: string;
    guidance?: string;
  }): string {
    if (context.mode === 'bug_hunt') {
      return `Translate the agreed bug explanation for run ${context.runId} into a concrete fix plan. List the files and modules to touch, outline the implementation steps, note any new tests to add, and call out risks or follow-up checks.${this.buildRunContextSuffix(context.description, context.guidance)}`;
    }
    return `Using the consensus requirements for run ${context.runId}, outline the technical implementation plan: list modules to touch, major steps for the implementer, and risks or open questions.${this.buildRunContextSuffix(context.description, context.guidance)}`;
  }

  private buildImplementerPrompt(context: {
    runId: string;
    mode: OrchestratorRunMode;
    description?: string;
    guidance?: string;
  }): string {
    if (context.mode === 'bug_hunt') {
      return `Apply the agreed bug fix for run ${context.runId}. Modify the code to resolve the root cause, keep the diff focused, update or add regression tests if needed, and summarise exactly how the fix eliminates the defect.${this.buildRunContextSuffix(context.description, context.guidance)}`;
    }
    return `Implement the approved plan for run ${context.runId}. Apply code changes directly in the repository, keeping diffs focused. After coding, summarise what was changed.${this.buildRunContextSuffix(context.description, context.guidance)}`;
  }

  private buildTesterPrompt(context: {
    runId: string;
    mode: OrchestratorRunMode;
    description?: string;
    guidance?: string;
  }): string {
    if (context.mode === 'bug_hunt') {
      return `Validate that the bug fix for run ${context.runId} works as intended. Reproduce the original failure to confirm it no longer occurs, run targeted and regression tests, and report pass/fail with supporting logs.${this.buildRunContextSuffix(context.description, context.guidance)}`;
    }
    return `Validate the implementation for run ${context.runId}. Run the prescribed test commands (e.g., npm test) and report pass/fail with logs or follow-up actions.${this.buildRunContextSuffix(context.description, context.guidance)}`;
  }

  private buildReviewerPrompt(context: {
    runId: string;
    mode: OrchestratorRunMode;
    description?: string;
    guidance?: string;
  }): string {
    if (context.mode === 'bug_hunt') {
      return `Review the bug fix for run ${context.runId}. Inspect the diff to ensure the root cause is addressed, verify tests cover the regression, and highlight any lingering risks before approving or requesting changes.${this.buildRunContextSuffix(context.description, context.guidance)}`;
    }
    return `Review the implementation for run ${context.runId}. Inspect the diff, note strengths/concerns, and approve or request changes with clear rationale.${this.buildRunContextSuffix(context.description, context.guidance)}`;
  }

  private createWatcher(
    root: string,
    worktreeId: string,
    refresh: () => Promise<void>
  ): { watcher: FSWatcher; cancelDebounce: () => void } {
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50
      }
    });

    let debounceTimer: NodeJS.Timeout | null = null;
    const cancelDebounce = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const schedule = () => {
      cancelDebounce();
      debounceTimer = setTimeout(() => {
        cancelDebounce();
        void refresh().catch((error) => {
          console.warn('[orchestrator] failed to refresh tasks after fs event', {
            worktreeId,
            message: (error as Error).message
          });
        });
      }, 200);
    };

    const events: Array<'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'> = [
      'add',
      'change',
      'unlink',
      'addDir',
      'unlinkDir'
    ];

    for (const event of events) {
      watcher.on(event, schedule);
    }

    watcher.on('error', (error) => {
      console.warn('[orchestrator] watcher error', { worktreeId, message: error instanceof Error ? error.message : String(error) });
    });

    watcher.on('ready', () => {
      schedule();
    });

    return { watcher, cancelDebounce };
  }

  private async loadDirectory(
    directoryPath: string,
    options: LoadTaskOptions,
    taskDirectory: TaskDirectory
  ): Promise<TaskEntry[]> {
    if (!(await this.exists(directoryPath))) {
      return [];
    }
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const records: TaskEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const absolutePath = path.join(directoryPath, entry.name);
      try {
        const content = await fs.readFile(absolutePath, 'utf8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const record = this.toTaskRecord(parsed, {
          worktreePath: options.worktreePath,
          fileName: entry.name,
          directory: taskDirectory,
          filePath: absolutePath,
          tasksRoot: options.tasksRoot,
          conversationRoot: options.conversationRoot
        });
        if (record) {
          records.push(record);
        }
      } catch (error) {
        console.warn('[orchestrator] failed to parse task file', {
          path: absolutePath,
          message: (error as Error).message
        });
      }
    }
    return records;
  }

  private toTaskRecord(
    payload: Record<string, unknown>,
    meta: {
      worktreePath: string;
      fileName: string;
      directory: TaskDirectory;
      filePath: string;
      tasksRoot: string;
      conversationRoot: string;
    }
  ): TaskEntry | null {
    const now = new Date().toISOString();
    const id = readString(payload, 'id') ?? readString(payload, 'task_id');
    if (!id) {
      return null;
    }
    const epicId = readString(payload, 'epic') ?? 'unknown';
    const statusFromPayload = payload.status;
    const status: TaskStatus = isTaskStatus(statusFromPayload) ? statusFromPayload : this.inferStatus(meta.directory);
    const kindValue = payload.kind;
    const kind: TaskKind = isTaskKind(kindValue) ? kindValue : this.inferKind(meta.directory);
    const roleValue = payload.role;
    const role: WorkerRole = isWorkerRole(roleValue) ? roleValue : this.inferRole(kind);
    const approvalsRequired = readNumber(payload, 'approvals_required') ?? 0;
    const approvals = readStringArray(payload, 'approvals');
    const dependsOn = readStringArray(payload, 'depends_on');
    const artifacts = readStringArray(payload, 'artifacts');
    const prompt = readString(payload, 'prompt') ?? '';
    const description = readString(payload, 'title') ?? `Task ${id}`;
    const assignee = readString(payload, 'assignee') ?? undefined;
    const lastClaimedBy = readString(payload, 'last_claimed_by') ?? undefined;
    const summary = readString(payload, 'summary') ?? undefined;
    const cwd = readString(payload, 'cwd') ?? '.';
    const createdAt = readString(payload, 'created_at') ?? now;
    const updatedAt = readString(payload, 'updated_at') ?? createdAt;
    const conversationRelative = ensurePosix(path.relative(meta.worktreePath, path.join(meta.conversationRoot, `${id}.md`)));
    const record: TaskRecord = {
      id,
      epicId,
      kind,
      role,
      title: description,
      prompt,
      status,
      cwd,
      dependsOn,
      approvalsRequired,
      approvals,
      artifacts,
      conversationPath: conversationRelative,
      summary,
      assignee,
      lastClaimedBy,
      createdAt,
      updatedAt
    };
    return {
      record,
      filePath: meta.filePath,
      directory: meta.directory
    };
  }

  private inferStatus(directory: TaskDirectory): TaskStatus {
    if (directory === 'done') {
      return 'done';
    }
    if (directory === 'review') {
      return 'awaiting_review';
    }
    return 'ready';
  }

  private inferKind(directory: TaskDirectory): TaskKind {
    switch (directory) {
      case 'analysis':
        return 'analysis';
      case 'consensus':
        return 'consensus';
      case 'impl':
        return 'impl';
      case 'test':
        return 'test';
      case 'review':
      case 'done':
      case 'backlog':
        return 'review';
      default:
        return 'analysis';
    }
  }

  private inferRole(kind: TaskKind): WorkerRole {
    switch (kind) {
      case 'analysis':
        return 'analyst_a';
      case 'consensus':
        return 'consensus_builder';
      case 'impl':
        return 'implementer';
      case 'test':
        return 'tester';
      case 'review':
        return 'reviewer';
      default:
        return 'implementer';
    }
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private async withTaskPayload<T>(
    worktreePath: string,
    tasksRoot: string,
    conversationRoot: string,
    taskId: string,
    handler: (
      payload: Record<string, unknown>,
      meta: {
        worktreePath: string;
        fileName: string;
        directory: TaskDirectory;
        filePath: string;
        tasksRoot: string;
        conversationRoot: string;
      }
    ) => Promise<T>
  ): Promise<T | null> {
    for (const directory of TASK_DIRECTORIES) {
      const directoryPath = path.join(tasksRoot, directory);
      if (!(await this.exists(directoryPath))) {
        continue;
      }
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }
        const filePath = path.join(directoryPath, entry.name);
        let payload: Record<string, unknown>;
        try {
          const content = await fs.readFile(filePath, 'utf8');
          payload = JSON.parse(content) as Record<string, unknown>;
        } catch (error) {
          console.warn('[orchestrator] failed to parse task file during mutation', {
            path: filePath,
            message: (error as Error).message
          });
          continue;
        }
        const candidateId = readString(payload, 'id') ?? readString(payload, 'task_id');
        if (candidateId !== taskId) {
          continue;
        }
        const result = await handler(payload, {
          worktreePath,
          fileName: entry.name,
          directory,
          filePath,
          tasksRoot,
          conversationRoot
        });
        return result;
      }
    }
    return null;
  }

  private async writeTaskFile(filePath: string, payload: Record<string, unknown>): Promise<void> {
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    await fs.writeFile(filePath, serialized, 'utf8');
  }

  private buildAnalysisPrompt(params: {
    role: WorkerRole;
    description: string;
    guidance?: string;
  }): string {
    const roleLabel = params.role === 'analyst_a' ? 'Analyst A' : 'Analyst B';
    const instructions = [
      `You are ${roleLabel} working inside a collaborative Codex orchestration.`,
      'Produce a concise set of requirements and acceptance criteria for the task below.',
      'Avoid implementation details; focus on scope, constraints, and critical user journeys.',
      '',
      `Task: ${params.description.trim()}`
    ];
    if (params.guidance?.trim()) {
      instructions.push('', `Additional guidance: ${params.guidance.trim()}`);
    }
    instructions.push('', 'Return markdown with clear headings and numbered acceptance criteria.');
    return instructions.join('\n');
  }
}
