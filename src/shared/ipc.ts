import type {
  BoxRecord, CompleteStepInput, DashboardStats, InventoryInput, InventoryPokemon,
  JsonExport, PokeMMOScanResult, SavedPlan, SavedPlanSummary, ScannerCalibration, ScannerFingerprint,
  ScannerHotkeyConfig, ScannerPreview, ScannerScanRequest, ScannerSource, Species
} from './types'

export const IPC = {
  speciesList: 'species:list', boxesList: 'boxes:list', boxesCreate: 'boxes:create',
  inventoryList: 'inventory:list', inventoryCreate: 'inventory:create', inventoryUpdate: 'inventory:update',
  inventoryDelete: 'inventory:delete', inventoryBulkCreate: 'inventory:bulk-create', inventoryBulkUpdate: 'inventory:bulk-update',
  plansList: 'plans:list', plansGet: 'plans:get', plansSave: 'plans:save', plansDelete: 'plans:delete',
  plansCompleteStep: 'plans:complete-step', plansReplaceMissing: 'plans:replace-missing',
  dashboardStats: 'dashboard:stats', historyList: 'history:list',
  backupCreate: 'backup:create', backupRestore: 'backup:restore', backupUndoLast: 'backup:undo-last', exportJson: 'data:export-json', importJson: 'data:import-json',
  dialogSave: 'dialog:save', dialogOpen: 'dialog:open', settingsGet: 'settings:get', settingsSet: 'settings:set',
  devLoadDataset: 'dev:load-dataset', appInfo: 'app:info', spriteGet: 'sprite:get',
  scannerSources: 'scanner:sources', scannerPreview: 'scanner:preview', scannerScanCurrent: 'scanner:scan-current',
  scannerFingerprint: 'scanner:fingerprint', scannerSetHotkey: 'scanner:set-hotkey', scannerCaptured: 'scanner:captured', scannerError: 'scanner:error'
} as const

export interface FileFilter { name: string; extensions: string[] }

export interface DesktopApi {
  species: { list(): Promise<Species[]> }
  boxes: { list(): Promise<BoxRecord[]>; create(name: string): Promise<BoxRecord> }
  inventory: {
    list(filters?: Record<string, unknown>): Promise<InventoryPokemon[]>
    create(input: InventoryInput): Promise<InventoryPokemon>
    update(id: number, input: Partial<InventoryInput>): Promise<InventoryPokemon>
    delete(id: number): Promise<void>
    bulkCreate(inputs: InventoryInput[]): Promise<InventoryPokemon[]>
    bulkUpdate(ids: number[], patch: Partial<InventoryInput>): Promise<void>
  }
  plans: {
    list(): Promise<SavedPlanSummary[]>; get(id: number): Promise<SavedPlan>
    save(name: string, tree: unknown): Promise<SavedPlan>; delete(id: number): Promise<void>
    completeStep(input: CompleteStepInput): Promise<SavedPlan>
    replaceMissing(planId: number, missingId: string, pokemonId: number): Promise<SavedPlan>
  }
  dashboard: { stats(): Promise<DashboardStats> }
  history: { list(): Promise<unknown[]> }
  backup: { create(path: string): Promise<string>; restore(path: string): Promise<void>; undoLast(): Promise<string> }
  data: { exportJson(path: string): Promise<string>; importJson(path: string): Promise<JsonExport> }
  dialog: { save(defaultPath: string, filters: FileFilter[]): Promise<string | null>; open(filters: FileFilter[]): Promise<string | null> }
  settings: { get(): Promise<Record<string, unknown>>; set(key: string, value: unknown): Promise<void> }
  dev: { loadDataset(): Promise<number> }
  app: { info(): Promise<{ version: string; development: boolean; databasePath: string }> }
  sprite: { get(speciesId: number): Promise<string | null> }
  scanner: {
    sources(): Promise<ScannerSource[]>
    preview(sourceId: string): Promise<ScannerPreview>
    scanCurrent(request: ScannerScanRequest): Promise<PokeMMOScanResult>
    fingerprint(sourceId: string, calibration: ScannerCalibration): Promise<ScannerFingerprint>
    setHotkey(config: ScannerHotkeyConfig): Promise<{ registered: boolean; message: string }>
    onCaptured(callback: (result: PokeMMOScanResult) => void): () => void
    onError(callback: (message: string) => void): () => void
  }
}
