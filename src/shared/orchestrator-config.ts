import type { WorkerRole } from './orchestrator';

export type ModelPriorityConfig = Partial<Record<WorkerRole, string[]>>;
export type WorkerCountConfig = Partial<Record<WorkerRole, number>>;
export interface WorkerSpawnConfig {
  role: WorkerRole;
  count: number;
  modelPriority: string[];
}

export const WORKER_ROLES: WorkerRole[] = [
  'analyst_a',
  'analyst_b',
  'consensus_builder',
  'splitter',
  'implementer',
  'tester',
  'reviewer'
];

export const AVAILABLE_MODELS = ['gpt-5-codex'] as const;

export const DEFAULT_PRIORITY: ModelPriorityConfig = {
  analyst_a: ['gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex'],
  analyst_b: ['gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex'],
  consensus_builder: ['gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex'],
  splitter: ['gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex'],
  implementer: ['gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex'],
  tester: ['gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex'],
  reviewer: ['gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex', 'gpt-5-codex']
};

export const DEFAULT_COUNTS: WorkerCountConfig = {
  analyst_a: 1,
  analyst_b: 1,
  consensus_builder: 1,
  splitter: 1,
  implementer: 1,
  tester: 1,
  reviewer: 1
};
