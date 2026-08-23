import { describe, expect, it } from 'vitest'
import { BreedingSimulator, InheritanceEngine, PokeMMORuleset } from '../src/domain/breeding'
import { ivs, node } from './helpers'

describe('guaranteed IV inheritance', () => {
  const engine = new InheritanceEngine()

  it('supports a brace from either parent and two different braces', () => {
    const a = node('a1', 443, 'Female', ivs({ hp: 31, atk: 7 }))
    const b = node('b2', 443, 'Male', ivs({ hp: 3, atk: 31 }))
    const result = engine.inherit(a, b, { type: 'Brace', stat: 'hp' }, { type: 'Brace', stat: 'atk' })
    expect(result.guaranteedIvs.hp).toBe(31)
    expect(result.guaranteedIvs.atk).toBe(31)
  })

  it('guarantees a shared value without wasting a brace', () => {
    const a = node('a1', 443, 'Female', ivs({ def: 23 }))
    const b = node('b2', 443, 'Male', ivs({ def: 23 }))
    const result = engine.inherit(a, b, { type: 'None' }, { type: 'None' })
    expect(result.possibleIvs.def).toEqual([23])
    expect(result.guaranteedIvs.def).toBe(23)
  })

  it('keeps every RNG outcome when parents differ, including non-31 and target 0', () => {
    const a = node('a1', 443, 'Female', ivs({ speed: 0, spAtk: 15 }))
    const b = node('b2', 443, 'Male', ivs({ speed: 31, spAtk: 6 }))
    const result = engine.inherit(a, b, { type: 'None' }, { type: 'None' })
    expect(result.possibleIvs.speed).toEqual([0, 15, 31])
    expect(result.guaranteedIvs.speed).toBeNull()
    expect(result.possibleIvs.spAtk).toEqual([6, 10, 15])
  })
})

describe('nature, Alpha and HA', () => {
  const simulator = new BreedingSimulator()

  it('passes nature only with a valid Everstone and prevents using a brace on that parent by representation', () => {
    const a = node('a1', 443, 'Female', ivs({ hp: 31 }), 'Jolly')
    const b = node('b2', 443, 'Male', ivs({ atk: 31 }), 'Adamant')
    const result = simulator.simulate(a, b, { type: 'Everstone', nature: 'Jolly' }, { type: 'Brace', stat: 'atk' }, 'Female')
    expect(result.valid).toBe(true)
    expect(result.result?.nature).toBe('Jolly')
    expect(result.result?.natureGuaranteed).toBe(true)
  })

  it('implements Alpha + Alpha and Alpha + Normal deterministically', () => {
    const alphaA = node('a1', 443, 'Female', ivs(), 'Jolly', true)
    const alphaB = node('b2', 443, 'Male', ivs(), 'Jolly', true)
    const normal = node('c3', 443, 'Male', ivs(), 'Jolly', false)
    expect(simulator.simulate(alphaA, alphaB, { type: 'None' }, { type: 'None' }, 'Female').result?.alpha).toBe(true)
    expect(simulator.simulate(alphaA, normal, { type: 'None' }, { type: 'None' }, 'Female').result?.alpha).toBe(false)
  })

  it('passes HA only from a non-Ditto parent in the offspring evolution line', () => {
    const femaleGible = node('a1', 443, 'Female', ivs(), 'Jolly', false, false)
    const maleGible = node('b2', 444, 'Male', ivs(), 'Jolly', false, true)
    const maleCharmander = node('c3', 4, 'Male', ivs(), 'Jolly', false, true)
    const dittoHa = node('d4', 132, 'Genderless', ivs(), 'Jolly', false, true)
    expect(simulator.simulate(femaleGible, maleGible, { type: 'None' }, { type: 'None' }, 'Female').result?.ha).toBe(true)
    expect(simulator.simulate(femaleGible, maleCharmander, { type: 'None' }, { type: 'None' }, 'Female').result?.ha).toBe(false)
    expect(simulator.simulate(femaleGible, dittoHa, { type: 'None' }, { type: 'None' }, 'Female').result?.ha).toBe(false)
  })
})

describe('compatibility, gender, Ditto and species', () => {
  const rules = new PokeMMORuleset()
  const simulator = new BreedingSimulator(rules)

  it('supports male/female cross-species breeding and the female determines the hatch species', () => {
    const femaleGible = node('a1', 443, 'Female', ivs())
    const maleCharmander = node('b2', 4, 'Male', ivs())
    const result = simulator.simulate(femaleGible, maleCharmander, { type: 'None' }, { type: 'None' }, 'Male')
    expect(result.valid).toBe(true)
    expect(result.result?.speciesId).toBe(443)
  })

  it('combines complementary 4x31 Pelipper and Golduck parents into a 5x31 Wingull', () => {
    const femalePelipper = node('pelipper', 279, 'Female', ivs({ hp: 31, def: 31, spAtk: 31, spDef: 31 }))
    const maleGolduck = node('golduck', 55, 'Male', ivs({ hp: 31, def: 31, spAtk: 31, speed: 31 }))
    const result = simulator.simulate(
      femalePelipper, maleGolduck,
      { type: 'Brace', stat: 'spDef' }, { type: 'Brace', stat: 'speed' }, 'Female'
    )
    expect(result.valid).toBe(true)
    expect(result.result?.speciesId).toBe(278)
    expect(result.result?.guaranteedIvs).toMatchObject({ hp: 31, def: 31, spAtk: 31, spDef: 31, speed: 31 })
  })

  it('supports Ditto + normal and Ditto + genderless, but rejects Ditto + Ditto and non-breedable', () => {
    const dittoA = node('a1', 132, 'Genderless', ivs())
    const dittoB = node('b2', 132, 'Genderless', ivs())
    const magnemite = node('c3', 81, 'Genderless', ivs())
    const gible = node('d4', 443, 'Male', ivs())
    const articuno = node('e5', 144, 'Genderless', ivs())
    expect(simulator.simulate(dittoA, gible, { type: 'None' }, { type: 'None' }, 'Female').valid).toBe(true)
    expect(simulator.simulate(dittoA, magnemite, { type: 'None' }, { type: 'None' }, 'Genderless').valid).toBe(true)
    expect(simulator.simulate(dittoA, dittoB, { type: 'None' }, { type: 'None' }, 'Genderless').valid).toBe(false)
    expect(simulator.simulate(dittoA, articuno, { type: 'None' }, { type: 'None' }, 'Genderless').valid).toBe(false)
  })

  it('supports genderless parents only inside the same evolution line', () => {
    const beldum = node('a1', 374, 'Genderless', ivs())
    const metang = node('b2', 375, 'Genderless', ivs())
    const magnemite = node('c3', 81, 'Genderless', ivs())
    expect(rules.compatibility(rules.describeNode(beldum), rules.describeNode(metang)).compatible).toBe(true)
    expect(rules.compatibility(rules.describeNode(beldum), rules.describeNode(magnemite)).compatible).toBe(false)
  })
})
