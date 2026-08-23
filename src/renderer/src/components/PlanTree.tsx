import { useMemo } from 'react'
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node } from '@xyflow/react'
import { STATS } from '../../../shared/constants'
import { nodeMeetsTargetIv, targetIvIsExact } from '../../../shared/target'
import type { BreedingPlanTree, BreedingTarget, PlanNode, Species } from '../../../shared/types'
import { Sprite } from './Sprite'

function layout(plan: BreedingPlanTree): { nodes: Node[]; edges: Edge[] } {
  const nodeMap = new Map(plan.nodes.map((node) => [node.id, node]))
  const parents = new Map(plan.steps.map((step) => [step.resultNodeId, [step.parentAId, step.parentBId] as const]))
  const positions = new Map<string, { x: number; y: number }>(); let leaf = 0
  const place = (id: string, depth: number): number => {
    const pair = parents.get(id)
    if (!pair) { const x = leaf++ * 230; positions.set(id, { x, y: depth * 190 }); return x }
    const left = place(pair[0], depth + 1); const right = place(pair[1], depth + 1); const x = (left + right) / 2
    positions.set(id, { x, y: depth * 190 }); return x
  }
  place(plan.rootNodeId, 0)
  const nodes: Node[] = [...positions].map(([id, position]) => ({ id, position, data: { model: nodeMap.get(id) }, type: 'planner' }))
  const edges: Edge[] = plan.steps.flatMap((step) => [
    { id: `${step.parentAId}-${step.resultNodeId}`, source: step.parentAId, target: step.resultNodeId, animated: step.status !== 'Completed', style: { stroke: '#5b78ff' } },
    { id: `${step.parentBId}-${step.resultNodeId}`, source: step.parentBId, target: step.resultNodeId, animated: step.status !== 'Completed', style: { stroke: '#5b78ff' } }
  ])
  return { nodes, edges }
}

function NodeCard({ data }: { data: { model: PlanNode; species: Species[]; target: BreedingTarget } }) {
  const node = data.model; const species = data.species.find((entry) => entry.id === node.speciesId)
  const guaranteed = STATS.filter((stat) => data.target.ivs[stat] !== null && nodeMeetsTargetIv(node, data.target, stat))
    .map((stat) => `${stat.toUpperCase()} ${targetIvIsExact(data.target, stat) ? data.target.ivs[stat] : `≥${data.target.ivs[stat]}`}`).join(' · ')
  return <div className={`flow-node ${node.kind} ${node.completed ? 'completed' : ''}`}>
    <Handle type="target" position={Position.Bottom} />
    <Handle type="source" position={Position.Top} />
    <Sprite speciesId={node.speciesId} size={38} />
    <div><strong>{node.kind === 'missing' ? node.missing?.id.toUpperCase() : species?.name ?? 'Intermediate'}</strong>
      <small>{node.inventoryId ? `#${node.inventoryId} · ` : ''}{node.gender} {node.alpha ? '· α' : ''} {node.ha ? '· HA' : ''}</small>
      <small>{guaranteed || 'No target IV guaranteed yet'}</small>
      {node.natureGuaranteed && <small>{node.nature}</small>}
      {node.boxName && <small>Box: {node.boxName}</small>}
    </div>
  </div>
}

export function PlanTree({ plan, species, onSelect }: { plan: BreedingPlanTree; species: Species[]; onSelect(node: PlanNode): void }) {
  const graph = useMemo(() => layout(plan), [plan])
  const nodeTypes = useMemo(() => ({ planner: ({ data }: { data: Record<string, unknown> }) => <NodeCard data={{ model: data.model as PlanNode, species, target: plan.target }} /> }), [species, plan.target])
  return <div className="tree-canvas"><ReactFlow nodes={graph.nodes.map((node) => ({ ...node, data: { ...node.data, species, target: plan.target } }))} edges={graph.edges} nodeTypes={nodeTypes}
    onNodeClick={(_event, node) => onSelect((node.data as Record<string, unknown>).model as PlanNode)} fitView minZoom={0.15} maxZoom={1.8} nodesDraggable={false}>
    <Background color="#243044" gap={24} /><Controls /></ReactFlow></div>
}
