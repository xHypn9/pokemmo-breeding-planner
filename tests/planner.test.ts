import { describe, expect, it } from 'vitest'
import { BreedingPlanner, PlanValidator } from '../src/domain/breeding'
import { normalizeTargetIvText, parseTargetIvText, targetIvIsExact, targetIvIsRequired, targetIvLabel, targetIvMatchesValue } from '../src/shared/target'
import type { BreedingTarget } from '../src/shared/types'
import { ivs, pokemon } from './helpers'

const exactTargetIvs = ivs({ hp: 31, atk: 31, def: 31, spAtk: 15, spDef: 31, speed: 31 })
const target: BreedingTarget = {
  speciesId: 445,
  ivs: exactTargetIvs,
  nature: 'Jolly', ha: 'Yes', alpha: 'Alpha', optimizer: 'balanced'
}

describe('planner and validator', () => {
  it('returns zero breeds when the exact selected Pokémon is already owned and satisfies the target', () => {
    const hydreigonTarget: BreedingTarget = {
      speciesId: 635,
      ivs: { hp: 30, atk: null, def: 30, spAtk: 30, spDef: 30, speed: 30 },
      ivExact: { hp: false, def: false, spAtk: false, spDef: false, speed: false },
      nature: 'Modest', ha: 'Any', alpha: 'Any', optimizer: 'balanced'
    }
    const ownedHydreigon = pokemon(241, 635, 'Male', { hp: 30, atk: 10, def: 30, spAtk: 30, spDef: 30, speed: 30 }, 'Modest', false, false)
    const plan = new BreedingPlanner().calculate([ownedHydreigon], hydreigonTarget)
    const root = plan.nodes.find((node) => node.id === plan.rootNodeId)
    expect(plan.valid).toBe(true)
    expect(plan.steps).toHaveLength(0)
    expect(plan.missingBreeders).toHaveLength(0)
    expect(plan.inventoryIds).toEqual([241])
    expect(root?.inventoryId).toBe(241)
    expect(root?.speciesId).toBe(635)
    expect(plan.diagnostics.statesExplored).toBe(0)
    expect(new PlanValidator().validate(plan)).toEqual({ valid: true, errors: [] })
  })

  it('upgrades one missing target IV without rebuilding an owned near-target Pokémon', () => {
    const hydreigonTarget: BreedingTarget = {
      speciesId: 635,
      ivs: { hp: 30, atk: 0, def: 30, spAtk: 31, spDef: 30, speed: 30 },
      ivExact: { hp: false, atk: false, def: false, spAtk: true, spDef: false, speed: false },
      nature: 'Modest', ha: 'Any', alpha: 'Any', optimizer: 'balanced'
    }
    const ownedHydreigon = pokemon(241, 635, 'Male', { hp: 30, atk: 10, def: 30, spAtk: 30, spDef: 30, speed: 30 }, 'Modest', false, false)
    const plan = new BreedingPlanner().calculate([ownedHydreigon], hydreigonTarget)
    const root = plan.nodes.find((node) => node.id === plan.rootNodeId)
    const finalStep = plan.steps.at(-1)

    expect(plan.valid).toBe(true)
    expect(plan.steps).toHaveLength(16)
    expect(plan.missingBreeders).toHaveLength(16)
    expect(plan.inventoryIds).toEqual([241])
    expect([finalStep?.parentAId, finalStep?.parentBId]).toContain('inventory-241')
    expect(root?.possibleIvs.spAtk).toEqual([31])
    for (const stat of ['hp', 'def', 'spDef', 'speed'] as const) expect(root?.possibleIvs[stat].every((value) => value >= 30)).toBe(true)
    expect(root?.nature).toBe('Modest')
    expect(new PlanValidator().validate(plan)).toEqual({ valid: true, errors: [] })
  })

  it('keeps non-breedable inventory records but never uses them as parents', () => {
    const nidorina = pokemon(99, 30, 'Female', exactTargetIvs, 'Jolly', true, true)
    const plan = new BreedingPlanner().calculate([nidorina], target, { maxStates: 1, maxRounds: 1 })
    expect(plan.inventoryIds).not.toContain(nidorina.id)
    expect(plan.valid).toBe(true)
  })

  it('parses exact, ignored and minimum target IV input', () => {
    expect(parseTargetIvText('')).toEqual({ valid: true, value: null, exact: true })
    expect(parseTargetIvText('25')).toEqual({ valid: true, value: 25, exact: false })
    expect(parseTargetIvText('25+')).toEqual({ valid: true, value: 25, exact: false })
    expect(parseTargetIvText('25 +')).toEqual({ valid: true, value: 25, exact: false })
    expect(parseTargetIvText('31')).toEqual({ valid: true, value: 31, exact: true })
    expect(parseTargetIvText('31+')).toEqual({ valid: true, value: 31, exact: true })
    expect(normalizeTargetIvText('25', false)).toBe('25+')
    expect(normalizeTargetIvText('25+', true)).toBe('25')
    expect(normalizeTargetIvText('31+', false)).toBe('31')
    expect(parseTargetIvText('32+').valid).toBe(false)
    expect(parseTargetIvText('abc').valid).toBe(false)
  })

  it('keeps old targets exact and lets minimum targets accept higher IVs', () => {
    const oldExact: BreedingTarget = { ...target, ivs: { ...target.ivs, hp: 25 } }
    const minimum: BreedingTarget = { ...oldExact, ivExact: { hp: false } }
    expect(targetIvMatchesValue(oldExact, 'hp', 25)).toBe(true)
    expect(targetIvMatchesValue(oldExact, 'hp', 26)).toBe(false)
    expect(targetIvMatchesValue(minimum, 'hp', 25)).toBe(true)
    expect(targetIvMatchesValue(minimum, 'hp', 31)).toBe(true)
    expect(targetIvMatchesValue(minimum, 'hp', 24)).toBe(false)
    const forced31: BreedingTarget = { ...minimum, ivs: { ...minimum.ivs, hp: 31 }, ivExact: { hp: false } }
    expect(targetIvIsExact(forced31, 'hp')).toBe(true)
    expect(targetIvLabel(forced31, 'hp')).toBe('31')
    const freeMinimum: BreedingTarget = { ...minimum, ivs: { ...minimum.ivs, hp: 0 }, ivExact: { hp: false } }
    expect(targetIvIsRequired(freeMinimum, 'hp')).toBe(false)
  })

  it('builds and validates external constraints for a minimum IV target', () => {
    const minimumHp: BreedingTarget = {
      ...target,
      ivs: { hp: 25, atk: null, def: null, spAtk: null, spDef: null, speed: null },
      ivExact: { hp: false }
    }
    const plan = new BreedingPlanner().calculate([], minimumHp, { maxStates: 1, maxRounds: 1 })
    const root = plan.nodes.find((node) => node.id === plan.rootNodeId)
    expect(plan.valid).toBe(true)
    expect(root?.possibleIvs.hp.every((value) => value >= 25)).toBe(true)
    expect(plan.missingBreeders.some((missing) => missing.minimumIvs?.hp === 25)).toBe(true)
    expect(plan.missingBreeders.every((missing) => missing.requiredIvs.hp === undefined)).toBe(true)
    expect(new PlanValidator().validate(plan)).toEqual({ valid: true, errors: [] })
  })

  it('uses owned breeders above a minimum without demanding an exact IV', () => {
    const minimumHp: BreedingTarget = {
      ...target,
      ivs: { hp: 25, atk: null, def: null, spAtk: null, spDef: null, speed: null },
      ivExact: { hp: false }
    }
    const inventory = [
      pokemon(1, 443, 'Female', ivs({ hp: 27 }), 'Jolly', true, true),
      pokemon(2, 443, 'Male', ivs({ hp: 29 }), 'Adamant', true, false)
    ]
    const plan = new BreedingPlanner().calculate(inventory, minimumHp, { maxStates: 1_000 })
    const root = plan.nodes.find((node) => node.id === plan.rootNodeId)
    expect(plan.valid).toBe(true)
    expect(plan.missingBreeders).toHaveLength(0)
    expect(plan.inventoryIds).toEqual([1, 2])
    expect(root?.possibleIvs.hp.every((value) => value >= 25)).toBe(true)
  })

  it('finds and validates a known one-breed inventory-only optimum', () => {
    const inventory = [
      pokemon(1, 443, 'Female', exactTargetIvs, 'Jolly', true, true),
      pokemon(2, 443, 'Male', exactTargetIvs, 'Adamant', true, false)
    ]
    const plan = new BreedingPlanner().calculate(inventory, target, { maxStates: 1_000 })
    expect(plan.valid).toBe(true)
    expect(plan.missingBreeders).toHaveLength(0)
    expect(plan.steps).toHaveLength(1)
    expect(plan.inventoryIds).toEqual([1, 2])
    expect(plan.steps[0]?.parentAItem.type === 'Everstone' || plan.steps[0]?.parentBItem.type === 'Everstone').toBe(true)
  })

  it('uses a compatible cross-species male for the final Wingull-line breed', () => {
    const pelipperTarget: BreedingTarget = {
      speciesId: 279,
      ivs: { hp: 31, atk: null, def: 31, spAtk: 31, spDef: 31, speed: 31 },
      nature: 'Bold', ha: 'Yes', alpha: 'Alpha', optimizer: 'balanced'
    }
    const femalePelipper = pokemon(1, 279, 'Female', ivs({ hp: 31, def: 31, spAtk: 31, spDef: 31 }), 'Bold', true, true)
    const maleGolduck = pokemon(2, 55, 'Male', ivs({ hp: 31, def: 31, spAtk: 31, spDef: 31, speed: 31 }), 'Adamant', true, true)
    const plan = new BreedingPlanner().calculate([femalePelipper, maleGolduck], pelipperTarget, { maxStates: 1_000 })
    const root = plan.nodes.find((node) => node.id === plan.rootNodeId)
    expect(plan.valid).toBe(true)
    expect(plan.steps).toHaveLength(1)
    expect(plan.inventoryIds).toEqual([1, 2])
    expect(plan.nodes.find((node) => node.inventoryId === 2)?.speciesId).toBe(55)
    expect(root?.speciesId).toBe(278)
  })

  it('uses a brace and Everstone on different parents', () => {
    const almost = { ...exactTargetIvs, atk: 0 }
    const inventory = [
      pokemon(1, 443, 'Female', almost, 'Jolly', true, true),
      pokemon(2, 443, 'Male', exactTargetIvs, 'Adamant', true, false)
    ]
    const plan = new BreedingPlanner().calculate(inventory, target, { maxStates: 1_000 })
    expect(plan.valid).toBe(true)
    const items = [plan.steps[0]?.parentAItem.type, plan.steps[0]?.parentBItem.type]
    expect(items).toContain('Brace')
    expect(items).toContain('Everstone')
  })

  it('creates simple generic missing constraints instead of naming species', () => {
    const plan = new BreedingPlanner().calculate([], target, { maxStates: 300 })
    expect(plan.valid).toBe(true)
    expect(plan.missingBreeders.length).toBeGreaterThan(1)
    expect(plan.missingBreeders.every((missing) => Object.keys(missing.requiredIvs).length <= 1)).toBe(true)
    expect(plan.nodes.filter((node) => node.kind === 'missing').every((node) => node.speciesId === null)).toBe(true)
    expect(plan.steps.length).toBeGreaterThan(2)
  })

  it('omits ignored target IVs from constraints and final validation', () => {
    const ignoredSpAtk: BreedingTarget = { ...target, ivs: { ...exactTargetIvs, spAtk: null } }
    const plan = new BreedingPlanner().calculate([], ignoredSpAtk, { maxStates: 1, maxRounds: 1 })
    expect(plan.valid).toBe(true)
    expect(plan.steps).toHaveLength(31)
    expect(plan.missingBreeders).toHaveLength(32)
    expect(plan.missingBreeders.every((missing) => missing.requiredIvs.spAtk === undefined)).toBe(true)
    expect(new PlanValidator().validate(plan)).toEqual({ valid: true, errors: [] })
  })

  it('treats 0+ as an unconstrained stat instead of building an extra breeding tier', () => {
    const zeroMinimumAtk: BreedingTarget = { ...target, ivs: { ...exactTargetIvs, atk: 0 }, ivExact: { atk: false } }
    const plan = new BreedingPlanner().calculate([], zeroMinimumAtk, { maxStates: 1, maxRounds: 1 })
    expect(plan.valid).toBe(true)
    expect(plan.steps).toHaveLength(31)
    expect(plan.missingBreeders).toHaveLength(32)
    expect(plan.missingBreeders.every((missing) => missing.requiredIvs.atk === undefined && missing.minimumIvs?.atk === undefined)).toBe(true)
  })

  it('supports a nature-only target with all six IVs ignored', () => {
    const natureOnly: BreedingTarget = { ...target, ivs: { hp: null, atk: null, def: null, spAtk: null, spDef: null, speed: null } }
    const plan = new BreedingPlanner().calculate([], natureOnly, { maxStates: 1, maxRounds: 1 })
    expect(plan.valid).toBe(true)
    expect(plan.steps).toHaveLength(1)
    expect(plan.missingBreeders).toHaveLength(2)
    expect(plan.missingBreeders.every((missing) => Object.keys(missing.requiredIvs).length === 0)).toBe(true)
  })

  it('uses the validated fallback immediately for a one-Pokémon starter inventory', () => {
    const lone = pokemon(1, 443, 'Female', exactTargetIvs, 'Jolly', true, true)
    const plan = new BreedingPlanner().calculate([lone], target)
    expect(plan.valid).toBe(true)
    expect(plan.diagnostics.statesExplored).toBe(0)
    expect(plan.inventoryIds).toContain(1)
  })

  it('validates a complete multi-level tree sourced only from unique inventory IDs', () => {
    const template = new BreedingPlanner().calculate([], target, { maxStates: 1, maxRounds: 1 })
    const inventory = template.missingBreeders.map((constraint, index) => {
      const values = ivs()
      for (const [stat, value] of Object.entries(constraint.requiredIvs)) values[stat as keyof typeof values] = value
      return pokemon(index + 1, 443, constraint.gender === 'Genderless' ? 'Female' : constraint.gender, values,
        constraint.nature ?? 'Hardy', constraint.alpha, constraint.ha === true)
    })
    const plan = new BreedingPlanner().calculate(inventory, target, { maxStates: 1, maxRounds: 1 })
    expect(plan.valid).toBe(true)
    expect(plan.steps.length).toBeGreaterThan(10)
    expect(plan.missingBreeders).toHaveLength(0)
    expect(new Set(plan.inventoryIds).size).toBe(plan.inventoryIds.length)
    expect(new PlanValidator().validate(plan)).toEqual({ valid: true, errors: [] })
  })

  it('validator rejects duplicated inventory provenance and invalid final targets', () => {
    const inventory = [
      pokemon(1, 443, 'Female', exactTargetIvs, 'Jolly', true, true),
      pokemon(2, 443, 'Male', exactTargetIvs, 'Adamant', true, false)
    ]
    const plan = new BreedingPlanner().calculate(inventory, target, { maxStates: 1_000 })
    const leaf = plan.nodes.find((entry) => entry.inventoryId === 2)
    if (!leaf) throw new Error('Expected inventory leaf')
    leaf.inventoryId = 1
    const validation = new PlanValidator().validate(plan)
    expect(validation.valid).toBe(false)
    expect(validation.errors.some((error) => error.includes('duplicated'))).toBe(true)
  })
})
