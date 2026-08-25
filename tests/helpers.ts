import { STATS } from '../src/shared/constants'
import type { Gender, InventoryPokemon, Ivs, Nature, PlanNode } from '../src/shared/types'

export const ivs = (values: Partial<Ivs> = {}): Ivs => ({ hp: 0, atk: 0, def: 0, spAtk: 0, spDef: 0, speed: 0, ...values })

export function node(id: string, speciesId: number, gender: Gender, values: Ivs, nature: Nature = 'Hardy', alpha = false, ha = false): PlanNode {
  return {
    id, kind: 'inventory', speciesId, inventoryId: Number(id.replace(/\D/g, '')) || undefined,
    gender, guaranteedIvs: { ...values },
    possibleIvs: Object.fromEntries(STATS.map((stat) => [stat, [values[stat]]])) as PlanNode['possibleIvs'],
    nature, natureGuaranteed: true, alpha, ha,
    provenanceInventoryIds: [Number(id.replace(/\D/g, '')) || 1], provenanceMissingIds: []
  }
}

export function pokemon(id: number, speciesId: number, gender: Gender, values: Ivs, nature: Nature = 'Hardy', alpha = false, ha = false): InventoryPokemon {
  return {
    id, speciesId, gender, ivs: values, nature, alpha, ha, boxId: 1, boxName: 'Test', notes: '', status: 'Available', breedingEnabled: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  }
}
