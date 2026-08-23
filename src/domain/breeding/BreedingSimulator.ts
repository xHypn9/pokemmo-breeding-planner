import type { Gender, HeldItem, PlanNode } from '../../shared/types'
import { InheritanceEngine } from './InheritanceEngine'
import { PokeMMORuleset } from './PokeMMORuleset'

export interface SimulationResult {
  valid: boolean
  errors: string[]
  result?: Omit<PlanNode, 'id' | 'kind' | 'provenanceInventoryIds' | 'provenanceMissingIds'>
  reasons: Array<{ property: string; reason: string }>
}

export class BreedingSimulator {
  constructor(private readonly rules = new PokeMMORuleset(), private readonly inheritance = new InheritanceEngine()) {}

  simulate(parentA: PlanNode, parentB: PlanNode, itemA: HeldItem, itemB: HeldItem, selectedGender: Gender, expectedSpeciesId?: number | null): SimulationResult {
    const a = this.rules.describeNode(parentA)
    const b = this.rules.describeNode(parentB)
    const compatibility = this.rules.compatibility(a, b)
    const errors: string[] = []
    if (!compatibility.compatible) errors.push(compatibility.reason)
    if (itemA.type === 'Brace' && itemB.type === 'Brace' && itemA.stat === itemB.stat) errors.push('Both parents cannot use a useful brace for the same IV')
    if (errors.length) return { valid: false, errors, reasons: [] }

    let speciesId = this.rules.childSpeciesId(a, b)
    if (speciesId === null && expectedSpeciesId) {
      const expected = this.rules.species(expectedSpeciesId)
      if (expected.evolutionChainId !== this.rules.childEvolutionChainId(a, b)) errors.push('Generic female constraint does not produce the expected evolution line')
      else speciesId = expectedSpeciesId
    }
    if (speciesId === null) errors.push('Cannot determine offspring species from generic parent constraints')
    if (speciesId !== null && !this.rules.selectableGenders(speciesId).includes(selectedGender)) errors.push(`Gender ${selectedGender} cannot be selected for offspring species #${speciesId}`)
    if (errors.length) return { valid: false, errors, reasons: [] }

    const inherited = this.inheritance.inherit(parentA, parentB, itemA, itemB)
    return {
      valid: true, errors: [], reasons: inherited.reasons,
      result: {
        speciesId,
        gender: selectedGender,
        guaranteedIvs: inherited.guaranteedIvs,
        possibleIvs: inherited.possibleIvs,
        nature: inherited.nature,
        natureGuaranteed: inherited.natureGuaranteed,
        alpha: this.rules.alphaInherited(a, b),
        ha: this.rules.haInherited(a, b)
      }
    }
  }
}
