import { STATS } from './constants'
import type { PlanStep, Stat } from './types'

const braceNames: Record<Stat, string> = {
  hp: 'Power Weight (HP)',
  atk: 'Power Bracer (ATK)',
  def: 'Power Belt (DEF)',
  spAtk: 'Power Lens (Sp. ATK)',
  spDef: 'Power Band (Sp. DEF)',
  speed: 'Power Anklet (Speed)'
}

export interface ShoppingListItem { name: string; quantity: number }
export interface ShoppingList { items: ShoppingListItem[]; total: number; remainingBreeds: number }

export function shoppingListForSteps(steps: readonly PlanStep[]): ShoppingList {
  const counts = new Map<string, number>()
  let remainingBreeds = 0
  for (const step of steps) {
    if (step.status === 'Completed') continue
    remainingBreeds += 1
    for (const item of [step.parentAItem, step.parentBItem]) {
      if (item.type === 'None') continue
      const key = item.type === 'Everstone' ? 'everstone' : item.stat
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  const items = [
    { key: 'everstone', name: 'Everstone' },
    ...STATS.map((stat) => ({ key: stat, name: braceNames[stat] }))
  ].flatMap(({ key, name }) => {
    const quantity = counts.get(key) ?? 0
    return quantity > 0 ? [{ name, quantity }] : []
  })
  return { items, total: items.reduce((sum, item) => sum + item.quantity, 0), remainingBreeds }
}
