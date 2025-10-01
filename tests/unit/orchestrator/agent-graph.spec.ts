import { describe, expect, it } from 'vitest';
import { deriveAgentGraphView } from '../../../src/renderer/orchestrator/store';
import type { TaskRecord, WorkerStatus } from '../../../src/shared/orchestrator';

const makeTask = (overrides: Partial<TaskRecord>): TaskRecord => ({
  id: overrides.id ?? 'task-1',
  epicId: overrides.epicId ?? 'epic-1',
  kind: overrides.kind ?? 'analysis',
  role: overrides.role ?? 'analyst_a',
  title: overrides.title ?? 'Task title',
  prompt: overrides.prompt ?? 'Prompt',
  status: overrides.status ?? 'ready',
  cwd: overrides.cwd ?? '.',
  dependsOn: overrides.dependsOn ?? [],
  approvalsRequired: overrides.approvalsRequired ?? 0,
  approvals: overrides.approvals ?? [],
  artifacts: overrides.artifacts ?? [],
  workerOutcome: overrides.workerOutcome,
  createdAt: overrides.createdAt ?? new Date().toISOString(),
  updatedAt: overrides.updatedAt ?? new Date().toISOString()
});

describe('deriveAgentGraphView', () => {
  it('marks roles with ready tasks as pending', () => {
    const { nodes } = deriveAgentGraphView({
      tasks: [makeTask({ id: 'analysis', role: 'analyst_a', status: 'ready' })],
      workers: [],
      agentStates: undefined
    });
    const analystNode = nodes.find((node) => node.id === 'analyst_a');
    expect(analystNode?.state).toBe('pending');
  });

  it('respects provided agentStates metadata', () => {
    const { nodes } = deriveAgentGraphView({
      tasks: [],
      workers: [],
      agentStates: {
        implementer: 'active'
      }
    });
    const implementerNode = nodes.find((node) => node.id === 'implementer');
    expect(implementerNode?.state).toBe('active');
  });

  it('highlights active edges when source node is active', () => {
    const workers: WorkerStatus[] = [
      {
        id: 'implementer-1',
        role: 'implementer',
        state: 'working',
        updatedAt: new Date().toISOString()
      }
    ];
    const { edges } = deriveAgentGraphView({ tasks: [], workers, agentStates: undefined });
    const implementerEdges = edges.filter((edge) => edge.source === 'implementer');
    expect(implementerEdges).not.toHaveLength(0);
    for (const edge of implementerEdges) {
      expect(edge.status).toBe('active');
    }
  });

  it('surfaces worker outcome details in node summaries', () => {
    const outcome = {
      status: 'changes_requested' as const,
      summary: 'Needs more tests.',
      details: 'Add regression coverage for edge cases.',
      documentPath: 'artifacts/REVIEW-1.outcome.json'
    };
    const tasks = [
      makeTask({
        id: 'review-task',
        role: 'reviewer',
        kind: 'review',
        status: 'changes_requested',
        summary: outcome.summary,
        artifacts: [outcome.documentPath],
        workerOutcome: outcome
      })
    ];
    const { nodes } = deriveAgentGraphView({ tasks, workers: [], agentStates: undefined });
    const reviewerNode = nodes.find((node) => node.id === 'reviewer');
    expect(reviewerNode?.status).toBe('Changes requested');
    expect(reviewerNode?.statusDetail).toContain('Needs more tests');
    expect(reviewerNode?.summary).toContain('Add regression coverage');
    expect(reviewerNode?.artifactPath).toBe(outcome.documentPath);
  });
});
