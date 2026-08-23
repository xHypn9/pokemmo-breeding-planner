import { SPECIES_BY_ID } from '../../data/species'
import type { Gender, PlanNode, Species } from '../../shared/types'

export interface BreederDescriptor {
  speciesId: number | null
  gender: Gender
  eggGroups: string[]
  breedable: boolean
  isDitto: boolean
  evolutionChainId: number
  hatchSpeciesId: number
  alpha: boolean
  ha: boolean
}

export interface CompatibilityResult { compatible: boolean; reason: string }

export class PokeMMORuleset {
  species(id: number): Species {
    const species = SPECIES_BY_ID.get(id)
    if (!species) throw new Error(`Unknown species #${id}`)
    return species
  }

  selectableGenders(speciesId: number): Gender[] {
    const species = this.species(speciesId)
    if (species.gender.kind === 'genderless') return ['Genderless']
    if (species.gender.femaleEighths === 0) return ['Male']
    if (species.gender.femaleEighths === 8) return ['Female']
    return ['Female', 'Male']
  }

  validateGender(speciesId: number, gender: Gender): boolean {
    return this.selectableGenders(speciesId).includes(gender)
  }

  describeNode(node: PlanNode): BreederDescriptor {
    if (node.speciesId !== null) {
      const species = this.species(node.speciesId)
      return {
        speciesId: species.id, gender: node.gender, eggGroups: species.eggGroups,
        breedable: species.breedable, isDitto: species.isDitto,
        evolutionChainId: species.evolutionChainId, hatchSpeciesId: species.hatchSpeciesId,
        alpha: node.alpha, ha: node.ha
      }
    }
    if (!node.missing) throw new Error(`Generic node ${node.id} has no missing constraint`)
    const ditto = node.missing.eggGroups.includes('ditto')
    return {
      speciesId: null, gender: node.gender, eggGroups: node.missing.eggGroups,
      breedable: true, isDitto: ditto,
      evolutionChainId: node.missing.evolutionChainId ?? (ditto ? 132 : 0),
      hatchSpeciesId: 0, alpha: node.alpha, ha: node.ha
    }
  }

  compatibility(a: BreederDescriptor, b: BreederDescriptor): CompatibilityResult {
    if (!a.breedable || !b.breedable) return { compatible: false, reason: 'Undiscovered/non-breedable parent' }
    if (a.isDitto && b.isDitto) return { compatible: false, reason: 'Ditto + Ditto cannot breed' }
    if (a.isDitto || b.isDitto) return { compatible: true, reason: 'Ditto with a breedable non-Ditto parent' }

    if (a.gender === 'Genderless' || b.gender === 'Genderless') {
      const valid = a.gender === 'Genderless' && b.gender === 'Genderless' && a.evolutionChainId !== 0 && a.evolutionChainId === b.evolutionChainId
      return { compatible: valid, reason: valid ? 'Genderless parents from the same evolution line' : 'Genderless parents require Ditto or the same evolution line' }
    }
    if (a.gender === b.gender) return { compatible: false, reason: 'Parents must have opposite genders' }
    const shared = a.eggGroups.some((group) => b.eggGroups.includes(group) && group !== 'no-eggs' && group !== 'ditto')
    return { compatible: shared, reason: shared ? 'Opposite genders share an Egg Group' : 'No shared Egg Group' }
  }

  childSpeciesId(a: BreederDescriptor, b: BreederDescriptor): number | null {
    if (!this.compatibility(a, b).compatible) return null
    if (a.isDitto) return b.speciesId === null ? null : b.hatchSpeciesId
    if (b.isDitto) return a.speciesId === null ? null : a.hatchSpeciesId
    if (a.gender === 'Genderless' && b.gender === 'Genderless') {
      return a.speciesId !== null ? a.hatchSpeciesId : b.speciesId !== null ? b.hatchSpeciesId : null
    }
    const female = a.gender === 'Female' ? a : b
    return female.speciesId === null ? null : female.hatchSpeciesId
  }

  childEvolutionChainId(a: BreederDescriptor, b: BreederDescriptor): number {
    if (a.isDitto) return b.evolutionChainId
    if (b.isDitto) return a.evolutionChainId
    if (a.gender === 'Female') return a.evolutionChainId
    if (b.gender === 'Female') return b.evolutionChainId
    return a.evolutionChainId
  }

  alphaInherited(a: BreederDescriptor, b: BreederDescriptor): boolean { return a.alpha && b.alpha }

  haInherited(a: BreederDescriptor, b: BreederDescriptor): boolean {
    const childLine = this.childEvolutionChainId(a, b)
    return [a, b].some((parent) => parent.ha && !parent.isDitto && parent.evolutionChainId === childLine)
  }
}
