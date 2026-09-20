import { RULESET_VERSION, STATS } from '../../shared/constants'
import { nodeMeetsTargetIv, targetIvIsExact, targetIvIsRequired } from '../../shared/target'
import type { BreedingPlanTree, PlanNode } from '../../shared/types'
import { BreedingSimulator } from './BreedingSimulator'
import { PokeMMORuleset } from './PokeMMORuleset'

const sameArray = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index])

export class PlanValidator {
  constructor(private readonly rules = new PokeMMORuleset(), private readonly simulator = new BreedingSimulator(rules)) {}

  validate(plan: BreedingPlanTree): { valid: boolean; errors: string[] } {
    const errors: string[] = []
    const nodes = new Map(plan.nodes.map((node) => [node.id, node]))
    const seenInventory = new Set<number>()
    const seenMissing = new Set<string>()
    const producedAt = new Map<string, number>()

    for (const node of plan.nodes) {
      if (node.kind === 'inventory' && !node.inventoryId) errors.push(`Inventory node ${node.id} has no inventory ID`)
      if (node.inventoryId) {
        if (seenInventory.has(node.inventoryId)) errors.push(`Inventory #${node.inventoryId} is duplicated in the tree`)
        else seenInventory.add(node.inventoryId)
      }
      if (node.kind === 'missing' && node.missing) {
        if (seenMissing.has(node.missing.id)) errors.push(`Missing breeder ${node.missing.id} is duplicated`)
        seenMissing.add(node.missing.id)
      }
    }

    const sortedSteps = [...plan.steps].sort((a, b) => a.order - b.order)
    sortedSteps.forEach((step, index) => {
      if (step.order !== index + 1) errors.push(`Step order is not contiguous at ${step.id}`)
      const parentA = nodes.get(step.parentAId)
      const parentB = nodes.get(step.parentBId)
      const result = nodes.get(step.resultNodeId)
      if (!parentA || !parentB || !result) { errors.push(`Step ${step.id} references a missing node`); return }
      const dependencyA = producedAt.get(parentA.id)
      const dependencyB = producedAt.get(parentB.id)
      if ((dependencyA ?? 0) >= step.order || (dependencyB ?? 0) >= step.order) errors.push(`Step ${step.id} runs before a dependency`)
      if (parentA.provenanceInventoryIds.some((id) => parentB.provenanceInventoryIds.includes(id))) errors.push(`Step ${step.id} reuses an inventory Pokémon in both branches`)
      if (parentA.provenanceMissingIds.some((id) => parentB.provenanceMissingIds.includes(id))) errors.push(`Step ${step.id} reuses a missing breeder in both branches`)
      const simulated = this.simulator.simulate(parentA, parentB, step.parentAItem, step.parentBItem, step.selectedGender, result.speciesId)
      if (!simulated.valid || !simulated.result) { errors.push(...simulated.errors.map((error) => `${step.id}: ${error}`)); return }
      if (simulated.result.speciesId !== result.speciesId) errors.push(`${step.id}: offspring species mismatch`)
      if (simulated.result.gender !== result.gender) errors.push(`${step.id}: offspring gender mismatch`)
      if (simulated.result.alpha !== result.alpha) errors.push(`${step.id}: Alpha inheritance mismatch`)
      if (simulated.result.ha !== result.ha) errors.push(`${step.id}: HA inheritance mismatch`)
      if (simulated.result.nature !== result.nature || simulated.result.natureGuaranteed !== result.natureGuaranteed) errors.push(`${step.id}: nature inheritance mismatch`)
      for (const stat of STATS) if (!sameArray(simulated.result.possibleIvs[stat], result.possibleIvs[stat])) errors.push(`${step.id}: ${stat} inheritance domain mismatch`)
      producedAt.set(result.id, step.order)
    })

    const root = nodes.get(plan.rootNodeId)
    if (!root) errors.push('Root node is missing')
    else {
      const targetSpecies = this.rules.species(plan.target.speciesId)
      const ownedWithoutBreeding = plan.steps.length === 0 && root.inventoryId !== undefined
      const expectedSpeciesId = ownedWithoutBreeding ? targetSpecies.id : targetSpecies.hatchSpeciesId
      if (root.speciesId !== expectedSpeciesId) {
        errors.push(ownedWithoutBreeding
          ? `Owned result must be ${targetSpecies.name}`
          : `Final offspring must hatch as ${this.rules.species(targetSpecies.hatchSpeciesId).name}`)
      }
      for (const stat of STATS) if (targetIvIsRequired(plan.target, stat) && !nodeMeetsTargetIv(root, plan.target, stat)) {
        const operator = targetIvIsExact(plan.target, stat) ? '=' : '>='
        errors.push(`Final ${stat}${operator}${plan.target.ivs[stat]} is not guaranteed`)
      }
      if (plan.target.nature !== null && (!root.natureGuaranteed || root.nature !== plan.target.nature)) errors.push(`Final nature ${plan.target.nature} is not guaranteed`)
      if (plan.target.alpha === 'Alpha' && !root.alpha) errors.push('Final Alpha is not guaranteed')
      if (plan.target.alpha === 'Normal' && root.alpha) errors.push('Final result is Alpha but Normal was requested')
      if (plan.target.ha === 'Yes' && !root.ha) errors.push('Final HA potential is not guaranteed')
      if (plan.target.ha === 'No' && root.ha) errors.push('Final result has HA potential but No was requested')
    }
    if (plan.rulesetVersion !== RULESET_VERSION) errors.push(`Ruleset version mismatch: ${plan.rulesetVersion}`)
    return { valid: errors.length === 0, errors }
  }
}

export function cloneNode(node: PlanNode): PlanNode { return structuredClone(node) }
