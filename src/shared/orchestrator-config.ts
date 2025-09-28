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

export const AVAILABLE_MODELS = [
  'gpt-5-codex-low',
  'gpt-5-codex-medium',
  'gpt-5-codex-high',
  'gpt-5-minimal',
  'gpt-5-low',
  'gpt-5-medium',
  'gpt-5-high'
] as const;

export const DEFAULT_PRIORITY: ModelPriorityConfig = {
  analyst_a: ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'gpt-5-medium'],
  analyst_b: ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'gpt-5-medium'],
  consensus_builder: ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'gpt-5-medium'],
  splitter: ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'gpt-5-medium'],
  implementer: ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'gpt-5-high'],
  tester: ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'gpt-5-medium'],
  reviewer: ['gpt-5-codex-high', 'gpt-5-codex-medium', 'gpt-5-codex-low', 'gpt-5-high']
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
