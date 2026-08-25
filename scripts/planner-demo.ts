import { BreedingPlanner, PlanValidator } from '../src/domain/breeding'
import type { BreedingTarget, InventoryPokemon } from '../src/shared/types'

const exact = { hp: 31, atk: 31, def: 31, spAtk: 15, spDef: 31, speed: 31 }
const make = (id: number, gender: 'Female' | 'Male', nature: 'Jolly' | 'Adamant', ha: boolean): InventoryPokemon => ({
  id, speciesId: 443, gender, ivs: exact, nature, alpha: true, ha, boxId: 1, boxName: 'Alpha Demo', notes: '', status: 'Available', breedingEnabled: true,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
})
const target: BreedingTarget = { speciesId: 445, ivs: exact, nature: 'Jolly', alpha: 'Alpha', ha: 'Yes', optimizer: 'balanced' }
const plan = new BreedingPlanner().calculate([make(1, 'Female', 'Jolly', true), make(2, 'Male', 'Adamant', false)], target)
const validation = new PlanValidator().validate(plan)
console.log(JSON.stringify({ target: 'Garchomp (hatches as Gible)', steps: plan.steps.length, inventory: plan.inventoryIds, missing: plan.missingBreeders.length, validation }, null, 2))
if (!validation.valid) process.exitCode = 1
