import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Edge,
  Handle,
  Node,
  NodeProps,
  Position,
  ReactFlowInstance,
  ReactFlowProvider,
  applyNodeChanges,
  type NodeChange
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { AgentGraphEdgeView, AgentGraphNodeView } from '../orchestrator/store';
import type { WorkerRole } from '@shared/orchestrator';

const NODE_POSITIONS: Record<WorkerRole, { x: number; y: number }> = {
  analyst_a: { x: 0, y: 0 },
  analyst_b: { x: 400, y: 0 },
  consensus_builder: { x: 200, y: 150 },
  splitter: { x: 200, y: 300 },
  implementer: { x: 200, y: 450 },
  tester: { x: 0, y: 600 },
  reviewer: { x: 400, y: 600 }
};

const NODE_DIMENSIONS = { width: 180, height: 72 };

type AgentNodeInternalData = AgentGraphNodeView & {
  onOpenArtifact?: (path: string) => void;
  onOpenLog?: (node: AgentGraphNodeView) => void;
};

const ROLE_HANDLES: Record<WorkerRole, { source?: { position: Position; id: string }; target?: { position: Position; id: string } }> = {
  analyst_a: {
    source: { position: Position.Bottom, id: 'out' }
  },
  analyst_b: {
    source: { position: Position.Bottom, id: 'out' }
  },
  consensus_builder: {
    source: { position: Position.Bottom, id: 'out' },
    target: { position: Position.Top, id: 'in' }
  },
  splitter: {
    source: { position: Position.Bottom, id: 'out' },
    target: { position: Position.Top, id: 'in' }
  },
  implementer: {
    source: { position: Position.Bottom, id: 'out' },
    target: { position: Position.Top, id: 'in' }
  },
  tester: {
    target: { position: Position.Top, id: 'in' }
  },
  reviewer: {
    target: { position: Position.Top, id: 'in' }
  }
};

const AgentNode: React.FC<NodeProps<AgentNodeInternalData>> = ({ id, data }) => {
  const handleConfig = ROLE_HANDLES[id as WorkerRole] ?? {};
  const showArtifact = data.artifactPath && (data.state === 'done' || data.state === 'active');
  const showConversation = data.conversationPath && (data.state === 'done' || data.state === 'active');

  const handleOpen = (event: React.MouseEvent<HTMLButtonElement>, path: string) => {
    event.stopPropagation();
    event.preventDefault();
    data.onOpenArtifact?.(path);
  };

  const handleActionPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handleActionMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handleActionTouchStart = (event: React.TouchEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handleLogClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    data.onOpenLog?.(data);
  };
  return (
    <div className={`agent-flow__node agent-flow__node--${data.state}`}>
      {handleConfig.target ? (
        <Handle
          type="target"
          position={handleConfig.target.position}
          isConnectable={false}
          id={handleConfig.target.id}
          className="agent-flow__handle"
        />
      ) : null}
      <span className="agent-flow__node-indicator" />
      <div className="agent-flow__node-body">
        <span className="agent-flow__node-title">{data.label}</span>
        {data.statusDetail ? <span className="agent-flow__node-status">{data.statusDetail}</span> : null}
        {!data.statusDetail && data.status ? (
          <span className="agent-flow__node-status">{data.status}</span>
        ) : null}
        {data.summary ? <span className="agent-flow__node-summary">{data.summary}</span> : null}
        {showArtifact || showConversation ? (
          <div className="agent-flow__node-actions">
            {showArtifact ? (
              <button
                type="button"
                className="agent-flow__node-action"
                onPointerDown={handleActionPointerDown}
                onMouseDown={handleActionMouseDown}
                onTouchStart={handleActionTouchStart}
                onClick={(event) => handleOpen(event, data.artifactPath!)}
                title={data.artifactPath!}
              >
                View output
              </button>
            ) : null}
            {showConversation ? (
              <button
                type="button"
                className="agent-flow__node-action"
                onPointerDown={handleActionPointerDown}
                onMouseDown={handleActionMouseDown}
                onTouchStart={handleActionTouchStart}
                onClick={handleLogClick}
                title={data.conversationPath!}
              >
                Open log
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {handleConfig.source ? (
        <Handle
          type="source"
          position={handleConfig.source.position}
          isConnectable={false}
          id={handleConfig.source.id}
          className="agent-flow__handle"
        />
      ) : null}
    </div>
  );
};

const nodeTypes = { agentNode: AgentNode };

export interface AgentFlowGraphProps {
  nodes: AgentGraphNodeView[];
  edges: AgentGraphEdgeView[];
  onOpenArtifact?: (path: string) => void;
  onOpenLog?: (node: AgentGraphNodeView) => void;
  visible: boolean;
}

const EDGE_COLORS: Record<AgentGraphEdgeView['status'], string> = {
  inactive: 'rgba(148, 163, 184, 0.45)',
  pending: 'rgba(234, 179, 8, 0.7)',
  active: 'rgba(34, 197, 94, 0.75)',
  done: 'rgba(59, 130, 246, 0.7)',
  error: 'rgba(248, 113, 113, 0.8)'
};

export const AgentFlowGraph: React.FC<AgentFlowGraphProps> = ({
  nodes,
  edges,
  onOpenArtifact,
  onOpenLog,
  visible
}) => {
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({ ...NODE_POSITIONS });

  const [flowNodes, setFlowNodes] = useState<Node<AgentNodeInternalData>[]>(() =>
    nodes.map((graphNode) => ({
      id: graphNode.id,
      type: 'agentNode',
      data: { ...graphNode, onOpenArtifact, onOpenLog },
      position: positionsRef.current[graphNode.id] ?? NODE_POSITIONS[graphNode.id] ?? { x: 0, y: 0 },
      draggable: true,
      selectable: false
    }))
  );

  useEffect(() => {
    const current = positionsRef.current;
    let mutated = false;
    for (const node of nodes) {
      if (!current[node.id]) {
        current[node.id] = NODE_POSITIONS[node.id] ?? { x: 0, y: 0 };
        mutated = true;
      }
    }
    if (mutated) {
      positionsRef.current = { ...current };
    }
    setFlowNodes((previous) => {
      const priorPositions = positionsRef.current;
      const existing = new Map(previous.map((node) => [node.id, node]));
      return nodes.map((graphNode) => {
        const prior = existing.get(graphNode.id);
        const position = priorPositions[graphNode.id] ?? NODE_POSITIONS[graphNode.id] ?? { x: 0, y: 0 };
        return {
          id: graphNode.id,
          type: 'agentNode',
          data: { ...graphNode, onOpenArtifact, onOpenLog },
          position,
          draggable: true,
          selectable: false,
          width: prior?.width,
          height: prior?.height
        } satisfies Node<AgentNodeInternalData>;
      });
    });
  }, [nodes, onOpenArtifact, onOpenLog]);

  const flowEdges = useMemo<Edge[]>(() => {
    return edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: edge.status === 'active',
      type: 'smoothstep',
      selectable: false,
      sourceHandle: ROLE_HANDLES[edge.source]?.source?.id,
      targetHandle: ROLE_HANDLES[edge.target]?.target?.id,
      className: `agent-flow__edge agent-flow__edge--${edge.status}`,
      style: {
        stroke: EDGE_COLORS[edge.status]
      }
    }));
  }, [edges]);

  const instanceRef = useRef<ReactFlowInstance | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const hasAutoFittedRef = useRef(false);
  const userLockedRef = useRef(false);

  const hasContainerDimensions = useCallback(() => {
    const element = containerRef.current;
    if (!element) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, []);

  const computeViewport = useCallback(() => {
    const element = containerRef.current;
    if (!element) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const xs = flowNodes.map((node) => node.position.x);
    const ys = flowNodes.map((node) => node.position.y);
    if (xs.length === 0 || ys.length === 0) {
      return null;
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs) + NODE_DIMENSIONS.width;
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys) + NODE_DIMENSIONS.height;
    const contentWidth = Math.max(maxX - minX, 1);
    const contentHeight = Math.max(maxY - minY, 1);
    const padding = 64;
    const availableWidth = Math.max(rect.width - padding, 50);
    const availableHeight = Math.max(rect.height - padding, 50);
    const scaleX = availableWidth / contentWidth;
    const scaleY = availableHeight / contentHeight;
    const zoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.3), 1.4);
    const centerX = minX + contentWidth / 2;
    const centerY = minY + contentHeight / 2;
    const offsetX = rect.width / 2 - centerX * zoom;
    const offsetY = rect.height / 2 - centerY * zoom;
    return { x: offsetX, y: offsetY, zoom };
  }, [flowNodes]);

  const requestFit = useCallback(
    (force = false) => {
      const instance = instanceRef.current;
      if (!instance || !visible || !hasContainerDimensions()) {
        return;
      }
      if (!force && (userLockedRef.current || hasAutoFittedRef.current)) {
        return;
      }
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
      }
      fitFrameRef.current = window.requestAnimationFrame(() => {
        const viewport = computeViewport();
        if (viewport) {
          instance.setViewport(viewport, { duration: force ? 200 : 0 });
        }
        fitFrameRef.current = null;
        hasAutoFittedRef.current = true;
      });
    },
    [computeViewport, hasContainerDimensions, visible]
  );

  const handleNodesChange = useCallback((changes: NodeChange<AgentNodeInternalData>[]) => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
    const updated = { ...positionsRef.current };
    let mutated = false;
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        updated[change.id] = change.position;
        mutated = true;
      }
    }
    if (mutated) {
      positionsRef.current = updated;
      userLockedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      hasAutoFittedRef.current = false;
      userLockedRef.current = false;
      return;
    }
    if (nodes.length === 0) {
      return;
    }
    requestFit(true);
  }, [visible, nodes.length, requestFit]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const element = containerRef.current;
    if (!element || hasAutoFittedRef.current) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          requestFit();
        }
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
      }
    };
  }, [requestFit]);

  return (
    <div ref={containerRef} className="agent-flow__container" data-testid="agent-flow-graph">
      <ReactFlowProvider>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll
          zoomOnDoubleClick
          panOnScroll={false}
          minZoom={0.4}
          maxZoom={1.5}
          defaultViewport={{ x: 0, y: 0, zoom: 0.75 }}
          onInit={(instance) => {
            instanceRef.current = instance;
            requestFit(true);
          }}
          onMoveStart={() => {
            if (hasAutoFittedRef.current) {
              userLockedRef.current = true;
            }
          }}
          onNodesChange={handleNodesChange}
          proOptions={{ hideAttribution: true }}
          style={{ width: '100%', height: '100%' }}
        >
          <Background gap={32} size={1} className="agent-flow__background" />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
};
