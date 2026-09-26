import type { BreedingPlanTree, PlanStep } from './types'

export function stepCompletionBlocker(tree: BreedingPlanTree, step: PlanStep): string | null {
  if (step.status === 'Completed') return 'This breed is already completed.'
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]))
  if (!nodes.has(step.resultNodeId)) return 'The result Pokémon is missing from the plan.'
  const parentIds = [step.parentAId, step.parentBId].map((id) => {
    const parent = nodes.get(id)
    if (!parent) return null
    if (parent.kind === 'missing') return null
    if ((parent.kind === 'intermediate' || parent.kind === 'result') && !parent.producedInventoryId) return null
    return parent.inventoryId ?? parent.producedInventoryId ?? null
  })
  if (parentIds.some((id) => id === null)) {
    const missing = [step.parentAId, step.parentBId].map((id) => nodes.get(id)).find((node) => node?.kind === 'missing')
    return missing ? `Replace ${missing.missing?.id ?? missing.id} first.` : 'Complete the prerequisite breed first.'
  }
  if (parentIds[0] === parentIds[1]) return 'This breed needs two different parents.'
  return null
}
