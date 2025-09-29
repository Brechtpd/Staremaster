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
});

