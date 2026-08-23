import type { NATURES, STATS } from './constants'

export type Stat = (typeof STATS)[number]
export type Nature = (typeof NATURES)[number]
export type Gender = 'Male' | 'Female' | 'Genderless'
export type PokemonStatus = 'Available' | 'Reserved' | 'Consumed'
export type PlanStatus = 'Draft' | 'Calculating' | 'Ready' | 'In Progress' | 'Completed' | 'Invalidated'
export type OptimizerMode = 'missing' | 'breeds' | 'balanced'
export type Requirement = 'Any' | 'Yes' | 'No'
export type AlphaRequirement = 'Any' | 'Normal' | 'Alpha'
export type Ivs = Record<Stat, number>
export type TargetIvs = Record<Stat, number | null>
export type GuaranteedIvs = Record<Stat, number | null>

export interface Species {
  id: number
  name: string
  slug: string
  eggGroups: string[]
  gender: { kind: 'ratio'; femaleEighths: number } | { kind: 'genderless' }
  breedable: boolean
  isDitto: boolean
  evolutionChainId: number
  hatchSpeciesId: number
  spriteId: number
  special?: string[]
}

export interface BoxRecord { id: number; name: string; createdAt: string }

export interface InventoryPokemon {
  id: number
  speciesId: number
  gender: Gender
  ivs: Ivs
  nature: Nature
  alpha: boolean
  ha: boolean
  boxId: number | null
  boxName?: string | null
  notes: string
  status: PokemonStatus
  createdAt: string
  updatedAt: string
}

export interface InventoryInput extends Omit<InventoryPokemon, 'id' | 'createdAt' | 'updatedAt' | 'boxName' | 'status'> {
  status?: PokemonStatus
}

export interface BreedingTarget {
  speciesId: number
  ivs: TargetIvs
  /** Missing means exact for backward compatibility with plans saved before v0.2.0. */
  ivExact?: Partial<Record<Stat, boolean>>
  nature: Nature
  ha: Requirement
  alpha: AlphaRequirement
  optimizer: OptimizerMode
}

export type HeldItem = { type: 'None' } | { type: 'Brace'; stat: Stat } | { type: 'Everstone'; nature: Nature }

export interface MissingConstraint {
  id: string
  eggGroups: string[]
  gender: Gender
  requiredIvs: Partial<Ivs>
  minimumIvs?: Partial<Ivs>
  nature: Nature | null
  alpha: boolean
  ha: boolean | null
  evolutionChainId?: number
  doubleGroupRequired?: boolean
  score: number
}

export type PlanNodeKind = 'inventory' | 'missing' | 'intermediate' | 'result'

export interface PlanNode {
  id: string
  kind: PlanNodeKind
  speciesId: number | null
  inventoryId?: number
  missing?: MissingConstraint
  gender: Gender
  guaranteedIvs: GuaranteedIvs
  possibleIvs: Record<Stat, number[]>
  nature: Nature | null
  natureGuaranteed: boolean
  alpha: boolean
  ha: boolean
  boxName?: string | null
  provenanceInventoryIds: number[]
  provenanceMissingIds: string[]
  completed?: boolean
  producedInventoryId?: number
}

export interface GuaranteeReason { property: string; reason: string }

export interface PlanStep {
  id: string
  order: number
  parentAId: string
  parentBId: string
  resultNodeId: string
  parentAItem: HeldItem
  parentBItem: HeldItem
  selectedGender: Gender
  reasons: GuaranteeReason[]
  status: 'Pending' | 'Completed'
}

export interface PlannerDiagnostics {
  statesExplored: number
  statesPruned: number
  cacheHits: number
  plansConsidered: number
  searchTimeMs: number
  bestObjectiveScore: number[] | null
  stoppedByLimit: boolean
  failureReason?: string
}

export interface BreedingPlanTree {
  id: string
  target: BreedingTarget
  rootNodeId: string
  nodes: PlanNode[]
  steps: PlanStep[]
  inventoryIds: number[]
  missingBreeders: MissingConstraint[]
  diagnostics: PlannerDiagnostics
  rulesetVersion: string
  valid: boolean
  validationErrors: string[]
}

export interface SavedPlanSummary {
  id: number
  name: string
  status: PlanStatus
  target: BreedingTarget
  createdAt: string
  updatedAt: string
}

export interface SavedPlan extends SavedPlanSummary { tree: BreedingPlanTree; diagnostics: PlannerDiagnostics }

export interface DashboardStats {
  available: number
  alpha: number
  ha: number
  boxes: number
  activePlans: number
  ivBuckets: Record<string, number>
  eggGroups: Array<{ name: string; count: number }>
}

export interface PlannerProgress { phase: string; explored: number; frontier: number; bestMissing: number | null }

export interface CompleteStepInput {
  planId: number
  stepId: string
  observedIvs?: Partial<Ivs>
  observedNature?: Nature
}

export interface JsonExport {
  schemaVersion: number
  exportedAt: string
  boxes: BoxRecord[]
  pokemon: InventoryPokemon[]
  plans: SavedPlan[]
  settings: Record<string, unknown>
}

export type ScannerRoiKey = 'species' | 'gender' | 'ivs' | 'nature' | 'alpha' | 'ha' | 'fingerprint'
export type ScanStatus = 'Verified' | 'Needs Review' | 'Error'

export interface NormalizedRoi { x: number; y: number; width: number; height: number }

export interface ScannerThresholds {
  verified: number
  error: number
  alphaColorRatio: number
  haColorRatio: number
  genderColorRatio: number
}

export interface ScannerCalibration {
  version: number
  /** Enabled by default when missing, for compatibility with calibrations saved before v0.2.4. */
  autoDetectBox?: boolean
  rois: Record<ScannerRoiKey, NormalizedRoi>
  thresholds: ScannerThresholds
  stableFrames: number
  pollIntervalMs: number
}

export interface ScannedField<T> {
  value: T | null
  confidence: number
  raw?: string
}

export interface ScannerSource {
  id: string
  name: string
  displayId: string
  thumbnailDataUrl?: string
}

export interface PokeMMOScanResult {
  id: string
  capturedAt: string
  sourceId: string
  sourceName: string
  fingerprint: string
  species: ScannedField<number>
  gender: ScannedField<Gender>
  ivs: Record<Stat, ScannedField<number>>
  nature: ScannedField<Nature>
  alpha: ScannedField<boolean>
  hiddenAbility: ScannedField<boolean>
  status: ScanStatus
  issues: string[]
  previewDataUrl?: string
  crops?: Partial<Record<Exclude<ScannerRoiKey, 'fingerprint'>, string>>
  debugDirectory?: string
}

export interface ScannerScanRequest {
  sourceId: string
  calibration: ScannerCalibration
  includeCrops?: boolean
  debugSave?: boolean
}

export interface ScannerPreview {
  sourceId: string
  sourceName: string
  width: number
  height: number
  dataUrl: string
  detectedBox?: NormalizedRoi
  suggestedRois?: Record<ScannerRoiKey, NormalizedRoi>
  detectionConfidence?: number
}

export interface ScannerFingerprint {
  value: string
  sourceName: string
}

export interface ScannerHotkeyConfig extends ScannerScanRequest {
  enabled: boolean
  accelerator: string
}

export interface ScannerImportSummary {
  added: number
  skipped: number
  errors: number
  boxName: string
}
