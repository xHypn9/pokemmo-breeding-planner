import { BreedingPlanner, PlanValidator } from '../src/domain/breeding'
import type { BreedingTarget, InventoryPokemon, Ivs, Stat } from '../src/shared/types'

const target: BreedingTarget = {
  speciesId: 445, ivs: { hp: 31, atk: 31, def: 31, spAtk: 15, spDef: 31, speed: 31 },
  nature: 'Jolly', ha: 'Yes', alpha: 'Alpha', optimizer: 'balanced'
}
const template = new BreedingPlanner().calculate([], target, { maxStates: 1, maxRounds: 1 })
const inventory: InventoryPokemon[] = template.missingBreeders.map((constraint, index) => {
  const ivs: Ivs = { hp: 0, atk: 0, def: 0, spAtk: 0, spDef: 0, speed: 0 }
  for (const [stat, value] of Object.entries(constraint.requiredIvs)) ivs[stat as Stat] = value
  return {
    id: index + 1, speciesId: 443, gender: constraint.gender === 'Genderless' ? 'Female' : constraint.gender,
    ivs, nature: constraint.nature ?? 'Hardy', alpha: constraint.alpha, ha: constraint.ha === true,
    boxId: 1, boxName: `Alpha ${(index % 4) + 1}`, notes: '', status: 'Available',
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  }
})
const plan = new BreedingPlanner().calculate(inventory, target, { maxStates: 1, maxRounds: 1 })
const validation = new PlanValidator().validate(plan)
console.log(JSON.stringify({
  tree: { steps: plan.steps.length, nodes: plan.nodes.length, root: plan.rootNodeId },
  resources: { uniqueInventoryIds: new Set(plan.inventoryIds).size, totalInventoryReferences: plan.inventoryIds.length, missing: plan.missingBreeders.length },
  final: plan.nodes.find((node) => node.id === plan.rootNodeId), validation
}, null, 2))
if (!validation.valid || plan.missingBreeders.length || new Set(plan.inventoryIds).size !== plan.inventoryIds.length) process.exitCode = 1
