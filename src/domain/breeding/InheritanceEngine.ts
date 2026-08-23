import { NATURES, STATS } from '../../shared/constants'
import type { GuaranteedIvs, HeldItem, Nature, PlanNode, Stat } from '../../shared/types'

export interface InheritanceResult {
  possibleIvs: Record<Stat, number[]>
  guaranteedIvs: GuaranteedIvs
  nature: Nature | null
  natureGuaranteed: boolean
  reasons: Array<{ property: string; reason: string }>
}

const uniqueSorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b)

export class InheritanceEngine {
  inherit(parentA: PlanNode, parentB: PlanNode, itemA: HeldItem, itemB: HeldItem): InheritanceResult {
    const possibleIvs = {} as Record<Stat, number[]>
    const guaranteedIvs = {} as GuaranteedIvs
    const reasons: Array<{ property: string; reason: string }> = []

    for (const stat of STATS) {
      const fromA = parentA.possibleIvs[stat]
      const fromB = parentB.possibleIvs[stat]
      let values: number[]
      if (itemA.type === 'Brace' && itemA.stat === stat) {
        values = [...fromA]
        reasons.push({ property: stat, reason: `Brace from ${parentA.id}` })
      } else if (itemB.type === 'Brace' && itemB.stat === stat) {
        values = [...fromB]
        reasons.push({ property: stat, reason: `Brace from ${parentB.id}` })
      } else {
        values = uniqueSorted(fromA.flatMap((a) => fromB.flatMap((b) => [a, b, Math.floor((a + b) / 2)])))
        if (values.length === 1) reasons.push({ property: stat, reason: 'Parents share the same guaranteed value' })
      }
      possibleIvs[stat] = uniqueSorted(values)
      guaranteedIvs[stat] = possibleIvs[stat].length === 1 ? possibleIvs[stat][0] ?? null : null
    }

    let nature: Nature | null = null
    let natureGuaranteed = false
    if (itemA.type === 'Everstone' && parentA.natureGuaranteed && parentA.nature === itemA.nature) {
      nature = itemA.nature; natureGuaranteed = true
      reasons.push({ property: 'nature', reason: `Everstone from ${parentA.id}` })
    }
    if (itemB.type === 'Everstone' && parentB.natureGuaranteed && parentB.nature === itemB.nature) {
      if (nature !== null && nature !== itemB.nature) { nature = null; natureGuaranteed = false }
      else { nature = itemB.nature; natureGuaranteed = true; reasons.push({ property: 'nature', reason: `Everstone from ${parentB.id}` }) }
    }
    if (!natureGuaranteed) nature = null
    return { possibleIvs, guaranteedIvs, nature, natureGuaranteed, reasons }
  }

  static unknownNatureDomain(): readonly Nature[] { return NATURES }
}
