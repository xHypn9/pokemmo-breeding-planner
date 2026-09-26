import { describe, expect, it } from 'vitest'
import { stepCompletionBlocker } from '../src/shared/planProgress'
import type { BreedingPlanTree, PlanStep } from '../src/shared/types'

const step = (id: string, parentAId: string, parentBId: string, status: PlanStep['status'] = 'Pending'): PlanStep => ({
  id, order: Number(id), parentAId, parentBId, resultNodeId: `result-${id}`,
  parentAItem: { type: 'None' }, parentBItem: { type: 'None' }, selectedGender: 'Female', reasons: [], status
})

const tree = (parentA: Record<string, unknown>, parentB: Record<string, unknown>, breed: PlanStep): BreedingPlanTree => ({
  nodes: [parentA, parentB, { id: breed.resultNodeId }], steps: [breed]
}) as unknown as BreedingPlanTree

describe('saved plan step completion', () => {
  it('allows a selected ready step even if it is not the first in the tree', () => {
    const breed = step('2', 'owned-a', 'owned-b')
    const plan = tree({ id: 'owned-a', kind: 'inventory', inventoryId: 10 }, { id: 'owned-b', kind: 'inventory', inventoryId: 11 }, breed)
    expect(stepCompletionBlocker(plan, breed)).toBeNull()
  })

  it('waits for a missing breeder or an unfinished prerequisite', () => {
    const breed = step('2', 'first-result', 'owned-b')
    const plan = tree({ id: 'first-result', kind: 'intermediate' }, { id: 'owned-b', kind: 'inventory', inventoryId: 11 }, breed)
    expect(stepCompletionBlocker(plan, breed)).toMatch(/prerequisite/)
    plan.nodes[0]!.producedInventoryId = 12
    expect(stepCompletionBlocker(plan, breed)).toBeNull()
    plan.nodes[0]!.kind = 'missing'
    plan.nodes[0]!.missing = { id: 'missing-001' } as NonNullable<typeof plan.nodes[0]['missing']>
    expect(stepCompletionBlocker(plan, breed)).toContain('missing-001')
  })

  it('does not allow completing a breed twice or using one parent twice', () => {
    const breed = step('3', 'owned-a', 'owned-b')
    const plan = tree({ id: 'owned-a', kind: 'inventory', inventoryId: 10 }, { id: 'owned-b', kind: 'inventory', inventoryId: 10 }, breed)
    expect(stepCompletionBlocker(plan, breed)).toMatch(/two different parents/)
    breed.status = 'Completed'
    expect(stepCompletionBlocker(plan, breed)).toMatch(/already completed/)
  })
})
