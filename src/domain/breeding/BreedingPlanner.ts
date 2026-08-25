import { RULESET_VERSION, STATS } from '../../shared/constants'
import { nodeMeetsTargetIv, targetIvIsExact, targetIvIsRequired } from '../../shared/target'
import type {
  BreedingPlanTree, BreedingTarget, Gender, GuaranteedIvs, HeldItem, InventoryPokemon,
  MissingConstraint, PlanNode, PlannerDiagnostics, PlannerProgress, PlanStep, Stat
} from '../../shared/types'
import { BreedingSimulator } from './BreedingSimulator'
import { PlanValidator } from './PlanValidator'
import { PokeMMORuleset } from './PokeMMORuleset'

const ALL_IVS = Array.from({ length: 32 }, (_, value) => value)

interface Candidate {
  node: PlanNode
  left?: Candidate
  right?: Candidate
  itemA?: HeldItem
  itemB?: HeldItem
  reasons?: Array<{ property: string; reason: string }>
  inventory: Set<number>
  missing: Set<string>
  missingScore: number
  breeds: number
}

export interface PlannerOptions {
  maxStates?: number
  maxFrontier?: number
  maxRounds?: number
  onProgress?: (progress: PlannerProgress) => void
  shouldCancel?: () => boolean
}

const bitCount = (mask: number) => {
  let value = mask; let count = 0
  while (value) { count += value & 1; value >>>= 1 }
  return count
}

const statMask = (node: PlanNode, target: BreedingTarget) => STATS.reduce((mask, stat, index) => (
  nodeMeetsTargetIv(node, target, stat) ? mask | (1 << index) : mask
), 0)
const requiredStatMask = (target: BreedingTarget) => STATS.reduce((mask, stat, index) => targetIvIsRequired(target, stat) ? mask | (1 << index) : mask, 0)

const union = <T>(a: Set<T>, b: Set<T>) => new Set([...a, ...b])
const disjoint = <T>(a: Set<T>, b: Set<T>) => ![...a].some((value) => b.has(value))
const ordered = <T>(set: Set<T>) => [...set].sort()
const itemKey = (item: HeldItem) => item.type === 'Brace' ? `b-${item.stat}` : item.type === 'Everstone' ? `e-${item.nature}` : 'none'

function fnv(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export class PlannerCancelledError extends Error { constructor() { super('Planner search cancelled') } }

export class BreedingPlanner {
  private readonly rules: PokeMMORuleset
  private readonly simulator: BreedingSimulator
  private readonly validator: PlanValidator
  private sequence = 0
  private missingSequence = 0

  constructor(rules = new PokeMMORuleset()) {
    this.rules = rules
    this.simulator = new BreedingSimulator(rules)
    this.validator = new PlanValidator(rules, this.simulator)
  }

  calculate(inventory: InventoryPokemon[], target: BreedingTarget, options: PlannerOptions = {}): BreedingPlanTree {
    this.sequence = 0; this.missingSequence = 0
    for (const stat of STATS) {
      const value = target.ivs[stat]
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 31)) throw new Error(`Target ${stat} must be 0–31 or ignored`)
    }
    const started = performance.now()
    const diagnostics: PlannerDiagnostics = {
      statesExplored: 0, statesPruned: 0, cacheHits: 0, plansConsidered: 0,
      searchTimeMs: 0, bestObjectiveScore: null, stoppedByLimit: false
    }
    const available = inventory.filter((pokemon) => pokemon.status === 'Available' && pokemon.breedingEnabled !== false)
    const actual = available.map((pokemon) => this.inventoryCandidate(pokemon))
      .filter((candidate) => target.alpha !== 'Alpha' || candidate.node.alpha)
    const ownedCandidates = [...actual]

    let best = actual.filter((candidate) => this.isExistingGoal(candidate, target))
      .sort((left, right) => (left.node.inventoryId ?? Number.MAX_SAFE_INTEGER) - (right.node.inventoryId ?? Number.MAX_SAFE_INTEGER))[0] ?? null
    if (best) diagnostics.failureReason = 'No breeding required: an available owned Pokémon already satisfies the selected target.'
    if (!best) {
      const maxStates = options.maxStates ?? 18_000
      const relevantActual = actual.filter((candidate) => this.isDirectlyRelevant(candidate, target))
      const alternatives: Array<{ candidate: Candidate; reason: string }> = []
      if (relevantActual.length > 1) {
        const inventoryBudget = Math.min(maxStates, Math.max(1, Math.min(6_000, Math.floor(maxStates / 3))))
        const inventoryBest = this.search(relevantActual, target, diagnostics, { ...options, maxStates: inventoryBudget }, ownedCandidates)
        if (inventoryBest) alternatives.push({ candidate: inventoryBest, reason: 'A complete solution was found using only compatible owned Pokémon.' })

        const remainingBudget = Math.max(0, maxStates - diagnostics.statesExplored)
        if (remainingBudget > 0) {
          const external = this.externalCandidates(target, 3)
          const mixedBest = this.search([...relevantActual, ...external], target, diagnostics, { ...options, maxStates: remainingBudget })
          if (mixedBest) alternatives.push({ candidate: mixedBest, reason: 'Compatible owned Pokémon and missing breeders were combined by the bounded search.' })
        }
      }

      const fallback = this.replaceWithOwnedCandidates(this.externalFallback(target), ownedCandidates, target)
      alternatives.push({ candidate: fallback, reason: 'Bounded search completed with inventory-first template completion; compatible owned branches were preserved.' })
      const anchored = this.incrementalCompletion(relevantActual, ownedCandidates, target)
      if (anchored) alternatives.push({ candidate: anchored, reason: 'An owned near-target Pokémon was preserved and only its complementary upgrade branch was built.' })

      const selected = alternatives.sort((left, right) => this.compare(left.candidate, right.candidate, target))[0]
      if (!selected) throw new Error('Planner could not create any candidate plan')
      best = selected.candidate
      diagnostics.failureReason = selected.reason
    }

    diagnostics.searchTimeMs = Math.round((performance.now() - started) * 100) / 100
    diagnostics.bestObjectiveScore = this.objective(best, target)
    const plan = this.finalize(best, target, diagnostics, available)
    const validation = this.validator.validate(plan)
    plan.valid = validation.valid
    plan.validationErrors = validation.errors
    if (!validation.valid) throw new Error(`Planner produced an invalid plan:\n${validation.errors.join('\n')}`)
    return plan
  }

  private inventoryCandidate(pokemon: InventoryPokemon): Candidate {
    const species = this.rules.species(pokemon.speciesId)
    const possibleIvs = Object.fromEntries(STATS.map((stat) => [stat, [pokemon.ivs[stat]]])) as PlanNode['possibleIvs']
    const node: PlanNode = {
      id: `inventory-${pokemon.id}`, kind: 'inventory', speciesId: pokemon.speciesId,
      inventoryId: pokemon.id, gender: pokemon.gender, guaranteedIvs: { ...pokemon.ivs }, possibleIvs,
      nature: pokemon.nature, natureGuaranteed: true, alpha: pokemon.alpha, ha: pokemon.ha,
      boxName: pokemon.boxName, provenanceInventoryIds: [pokemon.id], provenanceMissingIds: []
    }
    if (!species.breedable || !this.rules.validateGender(species.id, pokemon.gender)) {
      node.provenanceInventoryIds = []
    }
    return { node, inventory: new Set(node.provenanceInventoryIds), missing: new Set(), missingScore: 0, breeds: 0 }
  }

  private search(seed: Candidate[], target: BreedingTarget, diagnostics: PlannerDiagnostics, options: PlannerOptions, ownedCollector?: Candidate[]): Candidate | null {
    const maxStates = options.maxStates ?? 18_000
    const maxFrontier = options.maxFrontier ?? 1_200
    const maxRounds = options.maxRounds ?? 8
    let pool = this.prune(seed.filter((candidate) => candidate.node.provenanceInventoryIds.length > 0 || candidate.node.kind === 'missing'), target, maxFrontier, diagnostics)
    let frontier = [...pool]
    const seen = new Set<string>()
    let explored = 0

    for (let round = 0; round < maxRounds && frontier.length; round += 1) {
      const generated: Candidate[] = []
      for (let i = 0; i < frontier.length; i += 1) {
        const a = frontier[i] as Candidate
        for (let j = 0; j < pool.length; j += 1) {
          const b = pool[j] as Candidate
          if (a === b || !disjoint(a.inventory, b.inventory) || !disjoint(a.missing, b.missing)) { diagnostics.statesPruned += 1; continue }
          if (options.shouldCancel?.()) throw new PlannerCancelledError()
          for (const child of this.combineCandidates(a, b, target)) {
            diagnostics.statesExplored += 1; explored += 1
            if (explored >= maxStates) { diagnostics.stoppedByLimit = true; break }
            const signature = this.candidateSignature(child, target)
            if (seen.has(signature)) { diagnostics.cacheHits += 1; continue }
            seen.add(signature); generated.push(child)
            if (ownedCollector && child.missing.size === 0) ownedCollector.push(child)
          }
          if (explored >= maxStates) break
        }
        if (i % 25 === 0) options.onProgress?.({ phase: `Search round ${round + 1}`, explored: diagnostics.statesExplored, frontier: generated.length, bestMissing: null })
        if (explored >= maxStates) break
      }
      diagnostics.plansConsidered += generated.length
      const goals = generated.filter((candidate) => this.isGoal(candidate, target))
      if (goals.length) return goals.sort((a, b) => this.compare(a, b, target))[0] ?? null
      frontier = this.prune(generated, target, Math.max(160, Math.floor(maxFrontier / 2)), diagnostics)
      pool = this.prune([...pool, ...frontier], target, maxFrontier, diagnostics)
      options.onProgress?.({ phase: `Search round ${round + 1} complete`, explored: diagnostics.statesExplored, frontier: frontier.length, bestMissing: frontier[0]?.missing.size ?? null })
      if (explored >= maxStates) break
    }
    return null
  }

  private combineCandidates(a: Candidate, b: Candidate, target: BreedingTarget): Candidate[] {
    const descriptorA = this.rules.describeNode(a.node)
    const descriptorB = this.rules.describeNode(b.node)
    if (!this.rules.compatibility(descriptorA, descriptorB).compatible) return []
    let childSpeciesId = this.rules.childSpeciesId(descriptorA, descriptorB)
    const targetSpecies = this.rules.species(target.speciesId)
    if (childSpeciesId === null && this.rules.childEvolutionChainId(descriptorA, descriptorB) === targetSpecies.evolutionChainId) childSpeciesId = targetSpecies.hatchSpeciesId
    if (childSpeciesId === null) return []
    const genders = this.rules.selectableGenders(childSpeciesId)
    const maskA = statMask(a.node, target)
    const maskB = statMask(b.node, target)
    const common = maskA & maskB
    const itemsA = this.itemOptions(a.node, maskA & ~common, target)
    const itemsB = this.itemOptions(b.node, maskB & ~common, target)
    const results: Candidate[] = []
    const beforeUtility = bitCount(maskA | maskB) + Number(a.node.natureGuaranteed && a.node.nature === target.nature) + Number(b.node.natureGuaranteed && b.node.nature === target.nature)

    for (const itemA of itemsA) for (const itemB of itemsB) {
      if (itemA.type === 'Brace' && itemB.type === 'Brace' && itemA.stat === itemB.stat) continue
      for (const gender of genders) {
        const simulated = this.simulator.simulate(a.node, b.node, itemA, itemB, gender, childSpeciesId)
        if (!simulated.valid || !simulated.result) continue
        const node: PlanNode = {
          ...simulated.result, id: `candidate-${++this.sequence}`, kind: 'intermediate',
          provenanceInventoryIds: ordered(union(a.inventory, b.inventory)), provenanceMissingIds: ordered(union(a.missing, b.missing))
        }
        if (target.alpha === 'Alpha' && !node.alpha) continue
        const afterMask = statMask(node, target)
        const afterUtility = bitCount(afterMask) + Number(node.natureGuaranteed && node.nature === target.nature)
        const lineChanged = node.speciesId !== a.node.speciesId && node.speciesId !== b.node.speciesId
        const haGained = node.ha && !a.node.ha && !b.node.ha
        if (afterUtility === 0 || (afterUtility <= Math.max(bitCount(maskA), bitCount(maskB)) && !lineChanged && !haGained)) continue
        if (afterUtility + 2 < beforeUtility) continue
        results.push({
          node, left: a, right: b, itemA, itemB, reasons: simulated.reasons,
          inventory: union(a.inventory, b.inventory), missing: union(a.missing, b.missing),
          missingScore: a.missingScore + b.missingScore, breeds: a.breeds + b.breeds + 1
        })
      }
    }
    return results
  }

  private itemOptions(node: PlanNode, uniqueMask: number, target: BreedingTarget): HeldItem[] {
    const result: HeldItem[] = [{ type: 'None' }]
    STATS.forEach((stat, index) => { if (uniqueMask & (1 << index)) result.push({ type: 'Brace', stat }) })
    if (node.natureGuaranteed && node.nature === target.nature) result.push({ type: 'Everstone', nature: target.nature })
    return result
  }

  private stateKey(candidate: Candidate, target: BreedingTarget): string {
    const node = candidate.node
    const rangeState = STATS.map((stat) => {
      if (!targetIvIsRequired(target, stat) || targetIvIsExact(target, stat)) return ''
      const domain = node.possibleIvs[stat]
      return `${domain[0] ?? 'x'}-${domain[domain.length - 1] ?? 'x'}`
    }).join(',')
    return [node.speciesId, node.gender, statMask(node, target), rangeState, node.natureGuaranteed && node.nature === target.nature ? 1 : 0, node.alpha ? 1 : 0, node.ha ? 1 : 0].join('|')
  }

  private candidateSignature(candidate: Candidate, target: BreedingTarget): string {
    return `${this.stateKey(candidate, target)}|i:${ordered(candidate.inventory).join(',')}|m:${ordered(candidate.missing).join(',')}|${candidate.breeds}`
  }

  private prune(candidates: Candidate[], target: BreedingTarget, limit: number, diagnostics: PlannerDiagnostics): Candidate[] {
    const buckets = new Map<string, Candidate[]>()
    for (const candidate of candidates.sort((a, b) => this.compare(a, b, target))) {
      const key = this.stateKey(candidate, target)
      const bucket = buckets.get(key) ?? []
      const provenance = `${ordered(candidate.inventory).join(',')}|${ordered(candidate.missing).join(',')}`
      if (bucket.some((entry) => `${ordered(entry.inventory).join(',')}|${ordered(entry.missing).join(',')}` === provenance)) { diagnostics.statesPruned += 1; continue }
      if (bucket.length < 8) bucket.push(candidate)
      else diagnostics.statesPruned += 1
      buckets.set(key, bucket)
    }
    const flattened = [...buckets.values()].flat().sort((a, b) => this.compare(a, b, target))
    if (flattened.length > limit) diagnostics.statesPruned += flattened.length - limit
    return flattened.slice(0, limit)
  }

  private objective(candidate: Candidate, target: BreedingTarget): number[] {
    const valuableInventoryPenalty = target.alpha !== 'Alpha'
      ? [...candidate.inventory].filter((id) => candidate.node.provenanceInventoryIds.includes(id)).length * 0
      : 0
    if (target.optimizer === 'breeds') return [candidate.breeds, candidate.missing.size, candidate.missingScore, candidate.inventory.size + valuableInventoryPenalty]
    return [candidate.missing.size, candidate.missingScore, candidate.breeds, candidate.inventory.size + valuableInventoryPenalty]
  }

  private compare(a: Candidate, b: Candidate, target: BreedingTarget): number {
    const scoreA = this.objective(a, target); const scoreB = this.objective(b, target)
    for (let index = 0; index < scoreA.length; index += 1) {
      const difference = (scoreA[index] ?? 0) - (scoreB[index] ?? 0)
      if (difference) return difference
    }
    const utilityDifference = bitCount(statMask(b.node, target)) - bitCount(statMask(a.node, target))
    if (utilityDifference) return utilityDifference
    return a.node.id.localeCompare(b.node.id)
  }

  private isGoal(candidate: Candidate, target: BreedingTarget): boolean {
    const targetSpecies = this.rules.species(target.speciesId)
    return candidate.breeds > 0 && candidate.node.speciesId === targetSpecies.hatchSpeciesId && statMask(candidate.node, target) === requiredStatMask(target)
      && candidate.node.natureGuaranteed && candidate.node.nature === target.nature
      && (target.alpha === 'Any' || candidate.node.alpha === (target.alpha === 'Alpha'))
      && (target.ha === 'Any' || candidate.node.ha === (target.ha === 'Yes'))
  }

  private isExistingGoal(candidate: Candidate, target: BreedingTarget): boolean {
    return candidate.breeds === 0 && candidate.node.inventoryId !== undefined && candidate.node.speciesId === target.speciesId
      && statMask(candidate.node, target) === requiredStatMask(target)
      && candidate.node.natureGuaranteed && candidate.node.nature === target.nature
      && (target.alpha === 'Any' || candidate.node.alpha === (target.alpha === 'Alpha'))
      && (target.ha === 'Any' || candidate.node.ha === (target.ha === 'Yes'))
  }

  private isDirectlyRelevant(candidate: Candidate, target: BreedingTarget): boolean {
    if (candidate.node.speciesId === null || candidate.node.provenanceInventoryIds.length === 0) return false
    const species = this.rules.species(candidate.node.speciesId)
    if (!species.breedable) return false
    const hatch = this.rules.species(this.rules.species(target.speciesId).hatchSpeciesId)
    return species.isDitto || species.evolutionChainId === hatch.evolutionChainId
      || species.eggGroups.some((group) => hatch.eggGroups.includes(group))
  }

  private incrementalCompletion(actual: Candidate[], ownedCandidates: Candidate[], target: BreedingTarget): Candidate | null {
    const requiredMask = requiredStatMask(target)
    const hatch = this.rules.species(this.rules.species(target.speciesId).hatchSpeciesId)
    const selectable = this.rules.selectableGenders(hatch.id)
    if (selectable.length === 1 && selectable[0] !== 'Genderless') return null
    const completions: Candidate[] = []

    for (const anchor of actual) {
      if (anchor.node.inventoryId === undefined || anchor.node.speciesId !== target.speciesId) continue
      if (!anchor.node.natureGuaranteed || anchor.node.nature !== target.nature) continue
      if (target.alpha === 'Alpha' && !anchor.node.alpha) continue
      if (target.ha === 'No' && anchor.node.ha) continue
      const missingStats = STATS.filter((_, index) => (requiredMask & (1 << index)) !== 0 && (statMask(anchor.node, target) & (1 << index)) === 0)
      if (missingStats.length > 1) continue

      const partnerGender: Gender = anchor.node.gender === 'Male' ? 'Female' : anchor.node.gender === 'Female' ? 'Male' : 'Genderless'
      const needHa = target.ha === 'Yes' && !anchor.node.ha
      const sameLine = partnerGender !== 'Male' || needHa
      let complement = requiredMask === 0
        ? this.missingCandidate(0, false, partnerGender, needHa, false, target, sameLine)
        : this.buildRegular(requiredMask, partnerGender, needHa, target)
      const otherOwned = ownedCandidates.filter((candidate) => disjoint(candidate.inventory, anchor.inventory))
      complement = this.replaceWithOwnedCandidates(complement, otherOwned, target, true)

      const partnerItem: HeldItem = missingStats[0] ? { type: 'Brace', stat: missingStats[0] } : { type: 'None' }
      try {
        const completion = this.combineSpecified(anchor, complement, { type: 'Everstone', nature: target.nature }, partnerItem, selectable[0] as Gender, target)
        if (this.isGoal(completion, target)) completions.push(completion)
      } catch {
        // This anchor cannot produce the target line with a deterministic complementary parent.
      }
    }
    return completions.sort((left, right) => this.compare(left, right, target))[0] ?? null
  }

  private externalCandidates(target: BreedingTarget, copies: number): Candidate[] {
    const species = this.rules.species(this.rules.species(target.speciesId).hatchSpeciesId)
    const genders = this.rules.selectableGenders(species.id)
    const candidates: Candidate[] = []
    for (const gender of genders) for (let copy = 0; copy < copies; copy += 1) {
      STATS.forEach((stat, index) => {
        if (targetIvIsRequired(target, stat)) candidates.push(this.missingCandidate(1 << index, false, gender, target.ha === 'Yes' && gender !== 'Male' && index === 0 && copy === 0, false, target, gender !== 'Male'))
      })
      candidates.push(this.missingCandidate(0, true, gender, target.ha === 'Yes' && gender !== 'Male' && copy === 0, false, target, gender !== 'Male'))
    }
    return candidates
  }

  private missingCandidate(mask: number, nature: boolean, gender: Gender, ha: boolean, ditto: boolean, target: BreedingTarget, sameLine = true): Candidate {
    const targetSpecies = this.rules.species(this.rules.species(target.speciesId).hatchSpeciesId)
    const requiredIvs: Partial<Record<Stat, number>> = {}
    const minimumIvs: Partial<Record<Stat, number>> = {}
    const possibleIvs = {} as PlanNode['possibleIvs']
    const guaranteedIvs = {} as GuaranteedIvs
    STATS.forEach((stat, index) => {
      const wanted = target.ivs[stat]
      if (mask & (1 << index)) {
        if (wanted === null) throw new Error(`${stat} is ignored and cannot be required by a breeder template`)
        if (targetIvIsExact(target, stat)) {
          requiredIvs[stat] = wanted; possibleIvs[stat] = [wanted]; guaranteedIvs[stat] = wanted
        } else {
          minimumIvs[stat] = wanted; possibleIvs[stat] = ALL_IVS.filter((value) => value >= wanted)
          guaranteedIvs[stat] = possibleIvs[stat].length === 1 ? possibleIvs[stat][0] ?? null : null
        }
      }
      else { possibleIvs[stat] = [...ALL_IVS]; guaranteedIvs[stat] = null }
    })
    const alpha = target.alpha === 'Alpha'
    const id = `missing-${String(++this.missingSequence).padStart(3, '0')}`
    const constraint: MissingConstraint = {
      id, eggGroups: ditto ? ['ditto'] : sameLine ? [...targetSpecies.eggGroups] : [targetSpecies.eggGroups[0] ?? 'unknown'],
      gender: ditto ? 'Genderless' : gender, requiredIvs, minimumIvs, nature: nature ? target.nature : null,
      alpha, ha: target.ha === 'No' ? false : ha ? true : null, evolutionChainId: ditto || !sameLine ? undefined : targetSpecies.evolutionChainId,
      score: bitCount(mask) + (nature ? 2 : 0) + (alpha ? 1 : 0) + (ha ? 2 : 0) + (gender !== 'Genderless' ? 1 : 0)
    }
    const node: PlanNode = {
      id, kind: 'missing', speciesId: null, missing: constraint, gender: constraint.gender,
      guaranteedIvs, possibleIvs, nature: nature ? target.nature : null, natureGuaranteed: nature,
      alpha, ha, provenanceInventoryIds: [], provenanceMissingIds: [id]
    }
    return { node, inventory: new Set(), missing: new Set([id]), missingScore: constraint.score, breeds: 0 }
  }

  private externalFallback(target: BreedingTarget): Candidate {
    const hatch = this.rules.species(this.rules.species(target.speciesId).hatchSpeciesId)
    const selectable = this.rules.selectableGenders(hatch.id)
    const alpha = target.alpha === 'Alpha'
    void alpha
    const needHa = target.ha === 'Yes'
    const fullMask = requiredStatMask(target)
    if (fullMask === 0) {
      if (selectable.length === 1 && selectable[0] !== 'Genderless') {
        const gender = selectable[0] as Gender
        const speciesParent = this.missingCandidate(0, true, gender, needHa, false, target)
        const ditto = this.missingCandidate(0, false, 'Genderless', false, true, target)
        return this.combineSpecified(speciesParent, ditto, { type: 'Everstone', nature: target.nature }, { type: 'None' }, gender, target)
      }
      const gender = selectable[0] as Gender
      const parentGenders: [Gender, Gender] = gender === 'Genderless' ? ['Genderless', 'Genderless'] : ['Female', 'Male']
      const natureParent = this.missingCandidate(0, true, parentGenders[0], needHa, false, target)
      const otherParent = this.missingCandidate(0, false, parentGenders[1], false, false, target, parentGenders[1] !== 'Male')
      return this.combineSpecified(natureParent, otherParent, { type: 'Everstone', nature: target.nature }, { type: 'None' }, gender, target)
    }
    if (selectable.length === 1 && selectable[0] !== 'Genderless') return this.buildFixedNature(fullMask, selectable[0] as Gender, needHa, target)
    return this.buildNature(fullMask, selectable[0] as Gender, needHa, target)
  }

  private buildRegular(mask: number, gender: Gender, needHa: boolean, target: BreedingTarget): Candidate {
    if (bitCount(mask) === 1) return this.missingCandidate(mask, false, gender, needHa, false, target, gender !== 'Male' || needHa)
    const bits = STATS.map((_, index) => index).filter((index) => mask & (1 << index))
    const removeA = bits[bits.length - 1] as number
    const removeB = bits[bits.length - 2] as number
    const parentGenders: [Gender, Gender] = gender === 'Genderless' ? ['Genderless', 'Genderless'] : ['Female', 'Male']
    const left = this.buildRegular(mask & ~(1 << removeA), parentGenders[0], needHa, target)
    const right = this.buildRegular(mask & ~(1 << removeB), parentGenders[1], false, target)
    return this.combineSpecified(left, right, { type: 'Brace', stat: STATS[removeB] as Stat }, { type: 'Brace', stat: STATS[removeA] as Stat }, gender, target)
  }

  private buildNature(mask: number, gender: Gender, needHa: boolean, target: BreedingTarget): Candidate {
    if (mask === 0) return this.missingCandidate(0, true, gender, needHa, false, target, gender !== 'Male' || needHa)
    const bits = STATS.map((_, index) => index).filter((index) => mask & (1 << index))
    const added = bits[bits.length - 1] as number
    const parentGenders: [Gender, Gender] = gender === 'Genderless' ? ['Genderless', 'Genderless'] : ['Female', 'Male']
    const natureParent = this.buildNature(mask & ~(1 << added), parentGenders[0], needHa, target)
    const fullParent = this.buildRegular(mask, parentGenders[1], false, target)
    return this.combineSpecified(natureParent, fullParent, { type: 'Everstone', nature: target.nature }, { type: 'Brace', stat: STATS[added] as Stat }, gender, target)
  }

  private buildFixedRegular(mask: number, gender: Gender, needHa: boolean, target: BreedingTarget): Candidate {
    if (bitCount(mask) === 1) return this.missingCandidate(mask, false, gender, needHa, false, target)
    const bits = STATS.map((_, index) => index).filter((index) => mask & (1 << index))
    const added = bits[bits.length - 1] as number
    const speciesParent = this.buildFixedRegular(mask & ~(1 << added), gender, needHa, target)
    const ditto = this.missingCandidate(mask, false, 'Genderless', false, true, target)
    return this.combineSpecified(speciesParent, ditto, { type: 'None' }, { type: 'Brace', stat: STATS[added] as Stat }, gender, target)
  }

  private buildFixedNature(mask: number, gender: Gender, needHa: boolean, target: BreedingTarget): Candidate {
    if (mask === 0) return this.missingCandidate(0, true, gender, needHa, false, target)
    const bits = STATS.map((_, index) => index).filter((index) => mask & (1 << index))
    const added = bits[bits.length - 1] as number
    const natureParent = this.buildFixedNature(mask & ~(1 << added), gender, needHa, target)
    const ditto = this.missingCandidate(mask, false, 'Genderless', false, true, target)
    return this.combineSpecified(natureParent, ditto, { type: 'Everstone', nature: target.nature }, { type: 'Brace', stat: STATS[added] as Stat }, gender, target)
  }

  private combineSpecified(a: Candidate, b: Candidate, itemA: HeldItem, itemB: HeldItem, gender: Gender, target: BreedingTarget): Candidate {
    const hatchSpeciesId = this.rules.species(target.speciesId).hatchSpeciesId
    const simulated = this.simulator.simulate(a.node, b.node, itemA, itemB, gender, hatchSpeciesId)
    if (!simulated.valid || !simulated.result) throw new Error(`Fallback template is invalid: ${simulated.errors.join(', ')}`)
    const node: PlanNode = {
      ...simulated.result, id: `template-${++this.sequence}`, kind: 'intermediate',
      provenanceInventoryIds: ordered(union(a.inventory, b.inventory)), provenanceMissingIds: ordered(union(a.missing, b.missing))
    }
    return {
      node, left: a, right: b, itemA, itemB, reasons: simulated.reasons,
      inventory: union(a.inventory, b.inventory), missing: union(a.missing, b.missing),
      missingScore: a.missingScore + b.missingScore, breeds: a.breeds + b.breeds + 1
    }
  }

  private replaceWithOwnedCandidates(root: Candidate, ownedCandidates: Candidate[], target: BreedingTarget, replaceRoot = false): Candidate {
    const used = new Set<number>()
    const targetSpecies = this.rules.species(this.rules.species(target.speciesId).hatchSpeciesId)
    const targetGenders = this.rules.selectableGenders(targetSpecies.id)
    const crossSpeciesMaleAllowed = targetGenders.includes('Female') && targetGenders.includes('Male')
    const rankedOwned = ownedCandidates.filter((candidate) => candidate.missing.size === 0 && candidate.inventory.size > 0)
      .sort((left, right) => left.breeds - right.breeds || left.inventory.size - right.inventory.size || left.node.id.localeCompare(right.node.id))
    const speciesFits = (source: Candidate, template: Candidate): boolean => {
      if (source.node.speciesId === null) return false
      const species = this.rules.species(source.node.speciesId)
      if (!species.breedable) return false
      const constraint = template.node.missing
      if (constraint?.eggGroups.includes('ditto')) return species.isDitto
      if (species.isDitto) return false
      if (constraint?.evolutionChainId) return species.evolutionChainId === constraint.evolutionChainId
      if (constraint) return species.eggGroups.some((group) => constraint.eggGroups.includes(group))
      if (template.node.gender === 'Male' && crossSpeciesMaleAllowed) {
        return species.eggGroups.some((group) => targetSpecies.eggGroups.includes(group))
      }
      return species.evolutionChainId === targetSpecies.evolutionChainId
    }
    const matchCandidate = (template: Candidate): Candidate | undefined => rankedOwned.find((source) => {
      if (!disjoint(source.inventory, used) || source.node.gender !== template.node.gender) return false
      if (target.alpha !== 'Any' && source.node.alpha !== template.node.alpha) return false
      if (target.ha !== 'Any' && template.node.ha && !source.node.ha) return false
      if (target.ha === 'No' && source.node.ha !== template.node.ha) return false
      if (template.node.natureGuaranteed && (!source.node.natureGuaranteed || source.node.nature !== template.node.nature)) return false
      if (!STATS.every((stat) => source.node.possibleIvs[stat].every((value) => template.node.possibleIvs[stat].includes(value)))) return false
      return speciesFits(source, template)
    })
    const visit = (candidate: Candidate, allowWholeReplacement = true): Candidate => {
      if (allowWholeReplacement) {
        const whole = matchCandidate(candidate)
        if (whole) { for (const id of whole.inventory) used.add(id); return whole }
      }
      if (candidate.node.kind === 'missing') return candidate
      if (!candidate.left || !candidate.right || !candidate.itemA || !candidate.itemB) return candidate
      const left = visit(candidate.left); const right = visit(candidate.right)
      return this.combineSpecified(left, right, candidate.itemA, candidate.itemB, candidate.node.gender, target)
    }
    return visit(root, replaceRoot)
  }

  private finalize(root: Candidate, target: BreedingTarget, diagnostics: PlannerDiagnostics, inventory: InventoryPokemon[]): BreedingPlanTree {
    const nodes: PlanNode[] = []
    const steps: PlanStep[] = []
    const seen = new Set<string>()
    const visit = (candidate: Candidate): void => {
      if (candidate.left) visit(candidate.left)
      if (candidate.right) visit(candidate.right)
      if (!seen.has(candidate.node.id)) { nodes.push(candidate.node); seen.add(candidate.node.id) }
      if (candidate.left && candidate.right && candidate.itemA && candidate.itemB) {
        steps.push({
          id: `step-${steps.length + 1}`, order: steps.length + 1,
          parentAId: candidate.left.node.id, parentBId: candidate.right.node.id, resultNodeId: candidate.node.id,
          parentAItem: candidate.itemA, parentBItem: candidate.itemB, selectedGender: candidate.node.gender,
          reasons: candidate.reasons ?? [], status: 'Pending'
        })
      }
    }
    visit(root)
    root.node.kind = 'result'
    const inventorySnapshot = [...root.inventory].sort((a, b) => a - b)
    const planId = `plan-${fnv(JSON.stringify({ target, inventory: inventorySnapshot, missing: [...root.missing].sort() }))}`
    const plan: BreedingPlanTree = {
      id: planId, target, rootNodeId: root.node.id, nodes, steps,
      inventoryIds: inventorySnapshot,
      missingBreeders: nodes.flatMap((node) => node.missing ? [node.missing] : []),
      diagnostics, rulesetVersion: RULESET_VERSION, valid: false, validationErrors: []
    }
    void inventory
    return plan
  }
}
