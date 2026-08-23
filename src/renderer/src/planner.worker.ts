/// <reference lib="webworker" />
import { BreedingPlanner } from '../../domain/breeding'
import { PLANNER_MAX_STATES } from '../../shared/constants'
import type { BreedingTarget, InventoryPokemon } from '../../shared/types'

self.onmessage = (event: MessageEvent<{ inventory: InventoryPokemon[]; target: BreedingTarget }>) => {
  try {
    const planner = new BreedingPlanner()
    const plan = planner.calculate(event.data.inventory, event.data.target, {
      maxStates: PLANNER_MAX_STATES,
      onProgress: (progress) => self.postMessage({ type: 'progress', progress })
    })
    self.postMessage({ type: 'result', plan })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
