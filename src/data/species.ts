import generated from './species.generated.json'
import overrides from './pokemmo-overrides.json'
import type { Species } from '../shared/types'

type SpeciesOverride = Partial<Pick<Species, 'breedable' | 'hatchSpeciesId' | 'eggGroups' | 'gender' | 'special'>>
const mapped = overrides.species as Record<string, SpeciesOverride>

export const SPECIES: Species[] = (generated.species as Species[]).map((species) => ({
  ...species,
  ...(mapped[String(species.id)] ?? {})
}))

export const SPECIES_BY_ID = new Map(SPECIES.map((species) => [species.id, species]))
export const SPECIES_BY_NAME = new Map(SPECIES.flatMap((species) => [[species.name.toLowerCase(), species], [species.slug.toLowerCase(), species]]))
