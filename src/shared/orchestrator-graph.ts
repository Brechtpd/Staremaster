import type { WorkerRole } from './orchestrator';

export interface AgentGraphEdge {
  source: WorkerRole;
  target: WorkerRole;
}

export const AGENT_GRAPH_ROLES: WorkerRole[] = [
  'analyst_a',
  'analyst_b',
  'consensus_builder',
  'splitter',
  'implementer',
  'tester',
  'reviewer'
];

export const AGENT_GRAPH_EDGES: AgentGraphEdge[] = [
  { source: 'analyst_a', target: 'consensus_builder' },
  { source: 'analyst_b', target: 'consensus_builder' },
  { source: 'consensus_builder', target: 'splitter' },
  { source: 'splitter', target: 'implementer' },
  { source: 'implementer', target: 'tester' },
  { source: 'implementer', target: 'reviewer' }
];

export const AGENT_GRAPH_PARENTS: Record<WorkerRole, WorkerRole[]> = (() => {
  const parents: Record<WorkerRole, WorkerRole[]> = {
    analyst_a: [],
    analyst_b: [],
    consensus_builder: [],
    splitter: [],
    implementer: [],
    tester: [],
    reviewer: []
  };
  for (const edge of AGENT_GRAPH_EDGES) {
    parents[edge.target].push(edge.source);
  }
  return parents;
})();

