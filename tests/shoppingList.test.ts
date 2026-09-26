import { describe, expect, it } from 'vitest'
import { shoppingListForSteps } from '../src/shared/shoppingList'
import type { HeldItem, PlanStep } from '../src/shared/types'

const step = (id: string, status: PlanStep['status'], parentAItem: HeldItem, parentBItem: HeldItem): PlanStep => ({
  id, order: Number(id), parentAId: `${id}-a`, parentBId: `${id}-b`, resultNodeId: `${id}-result`,
  parentAItem, parentBItem, selectedGender: 'Female', reasons: [], status
})

describe('breeding shopping list', () => {
  it('totals each consumed item across pending steps and excludes completed steps', () => {
    const steps = [
      step('1', 'Pending', { type: 'Brace', stat: 'hp' }, { type: 'Everstone', nature: 'Modest' }),
      step('2', 'Pending', { type: 'Brace', stat: 'hp' }, { type: 'Brace', stat: 'speed' }),
      step('3', 'Pending', { type: 'Everstone', nature: 'Jolly' }, { type: 'None' }),
      step('4', 'Completed', { type: 'Brace', stat: 'atk' }, { type: 'Everstone', nature: 'Modest' })
    ]

    expect(shoppingListForSteps(steps)).toEqual({
      items: [
        { name: 'Everstone', quantity: 2 },
        { name: 'Power Weight (HP)', quantity: 2 },
        { name: 'Power Anklet (Speed)', quantity: 1 }
      ],
      total: 5,
      remainingBreeds: 3
    })

    steps[0]!.status = 'Completed'
    expect(shoppingListForSteps(steps)).toEqual({
      items: [
        { name: 'Everstone', quantity: 1 },
        { name: 'Power Weight (HP)', quantity: 1 },
        { name: 'Power Anklet (Speed)', quantity: 1 }
      ],
      total: 3,
      remainingBreeds: 2
    })
  })

  it('shows no purchase requirements for a zero-breed plan', () => {
    expect(shoppingListForSteps([])).toEqual({ items: [], total: 0, remainingBreeds: 0 })
  })
})
