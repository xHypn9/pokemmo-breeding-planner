import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type DesktopApi } from '../shared/ipc'

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: DesktopApi = {
  species: { list: () => invoke(IPC.speciesList) },
  boxes: { list: () => invoke(IPC.boxesList), create: (name) => invoke(IPC.boxesCreate, name) },
  inventory: {
    list: (filters) => invoke(IPC.inventoryList, filters), create: (input) => invoke(IPC.inventoryCreate, input),
    update: (id, input) => invoke(IPC.inventoryUpdate, id, input), delete: (id) => invoke(IPC.inventoryDelete, id),
    bulkCreate: (inputs) => invoke(IPC.inventoryBulkCreate, inputs), bulkUpdate: (ids, patch) => invoke(IPC.inventoryBulkUpdate, ids, patch)
  },
  plans: {
    list: () => invoke(IPC.plansList), get: (id) => invoke(IPC.plansGet, id), save: (name, tree) => invoke(IPC.plansSave, name, tree),
    delete: (id) => invoke(IPC.plansDelete, id), completeStep: (input) => invoke(IPC.plansCompleteStep, input),
    replaceMissing: (planId, missingId, pokemonId) => invoke(IPC.plansReplaceMissing, planId, missingId, pokemonId)
  },
  dashboard: { stats: () => invoke(IPC.dashboardStats) }, history: { list: () => invoke(IPC.historyList) },
  backup: { create: (path) => invoke(IPC.backupCreate, path), restore: (path) => invoke(IPC.backupRestore, path), undoLast: () => invoke(IPC.backupUndoLast) },
  data: { exportJson: (path) => invoke(IPC.exportJson, path), importJson: (path) => invoke(IPC.importJson, path) },
  dialog: { save: (defaultPath, filters) => invoke(IPC.dialogSave, defaultPath, filters), open: (filters) => invoke(IPC.dialogOpen, filters) },
  settings: { get: () => invoke(IPC.settingsGet), set: (key, value) => invoke(IPC.settingsSet, key, value) },
  dev: { loadDataset: () => invoke(IPC.devLoadDataset) }, app: { info: () => invoke(IPC.appInfo) },
  sprite: { get: (speciesId) => invoke(IPC.spriteGet, speciesId) },
  scanner: {
    sources: () => invoke(IPC.scannerSources), preview: (sourceId) => invoke(IPC.scannerPreview, sourceId),
    scanCurrent: (request) => invoke(IPC.scannerScanCurrent, request),
    fingerprint: (sourceId, calibration) => invoke(IPC.scannerFingerprint, sourceId, calibration),
    setHotkey: (config) => invoke(IPC.scannerSetHotkey, config),
    onCaptured: (callback) => {
      const listener = (_event: IpcRendererEvent, result: Parameters<typeof callback>[0]) => callback(result)
      ipcRenderer.on(IPC.scannerCaptured, listener)
      return () => ipcRenderer.removeListener(IPC.scannerCaptured, listener)
    },
    onError: (callback) => {
      const listener = (_event: IpcRendererEvent, message: string) => callback(message)
      ipcRenderer.on(IPC.scannerError, listener)
      return () => ipcRenderer.removeListener(IPC.scannerError, listener)
    }
  }
}

contextBridge.exposeInMainWorld('desktopApi', Object.freeze(api))
