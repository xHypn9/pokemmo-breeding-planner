import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, safeStorage, session, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { SPECIES } from '../data/species'
import { PokeMMORuleset } from '../domain/breeding'
import { IPC, type FileFilter } from '../shared/ipc'
import { DEFAULT_SCANNER_CALIBRATION } from '../shared/scanner'
import type { BreedingPlanTree, InventoryInput, JsonExport } from '../shared/types'
import { AppDatabase } from './database/Database'
import { AppRepository } from './database/Repository'
import { IniSettings } from './services/IniSettings'
import { BackupService } from './services/BackupService'
import { CloudBackupService, CloudStateStore } from './services/CloudBackupService'
import { GoogleDriveService } from './services/GoogleDriveService'
import { EncryptedRefreshTokenStore, GoogleOAuthService } from './services/GoogleOAuthService'
import { SpriteProvider } from './services/SpriteProvider'
import { ScannerService } from './services/ScannerService'
import { RecognitionEngine } from './scanner/RecognitionEngine'
import eng from '@tesseract.js-data/eng'
import {
  completeStepSchema, filtersSchema, idSchema, inventoryPatchSchema, inventorySchema, pathSchema,
  scannerCalibrationSchema, scannerHotkeySchema, scannerScanRequestSchema
} from './validation'

const dirname = fileURLToPath(new URL('.', import.meta.url))
declare const __GOOGLE_OAUTH_CLIENT_ID__: string
declare const __GOOGLE_OAUTH_CLIENT_SECRET__: string
const development = !app.isPackaged
const isolatedUserData = process.env.POKEMMO_PLANNER_USER_DATA
if (isolatedUserData) app.setPath('userData', isolatedUserData)
else if (development) app.setPath('userData', join(app.getPath('appData'), 'PokeMMO Breeding Planner Dev'))

let database: AppDatabase
let repository: AppRepository
let preferences: IniSettings
let backup: BackupService
let cloud: CloudBackupService | undefined
let sprites: SpriteProvider
let scanner: ScannerService
let mainWindow: BrowserWindow | null = null
let hotkeyAccelerator: string | null = null
let hotkeyBusy = false
const rules = new PokeMMORuleset()

function validateInventory(input: unknown): InventoryInput {
  const parsed = inventorySchema.parse(input)
  const species = rules.species(parsed.speciesId)
  if (!rules.validateGender(parsed.speciesId, parsed.gender)) throw new Error(`${species.name} cannot have gender ${parsed.gender}`)
  return parsed
}

function registerIpc(): void {
  ipcMain.handle(IPC.speciesList, () => SPECIES)
  ipcMain.handle(IPC.boxesList, () => repository.boxes())
  ipcMain.handle(IPC.boxesCreate, (_event, name) => repository.createBox(z.string().trim().min(1).max(80).parse(name)))
  ipcMain.handle(IPC.inventoryList, (_event, filters) => repository.inventory(filtersSchema.parse(filters ?? {})))
  ipcMain.handle(IPC.inventoryCreate, (_event, input) => repository.createPokemon(validateInventory(input)))
  ipcMain.handle(IPC.inventoryUpdate, (_event, id, patch) => {
    const parsedId = idSchema.parse(id); const parsedPatch = inventoryPatchSchema.parse(patch)
    const current = repository.inventoryById(parsedId)
    validateInventory({ ...current, ...parsedPatch, ivs: { ...current.ivs, ...(parsedPatch.ivs ?? {}) } })
    return repository.updatePokemon(parsedId, parsedPatch)
  })
  ipcMain.handle(IPC.inventoryDelete, (_event, id) => repository.deletePokemon(idSchema.parse(id)))
  ipcMain.handle(IPC.inventoryBulkCreate, (_event, inputs) => repository.bulkCreatePokemon(z.array(z.unknown()).min(1).max(1_000).parse(inputs).map(validateInventory)))
  ipcMain.handle(IPC.inventoryBulkUpdate, (_event, ids, patch) => repository.bulkUpdatePokemon(z.array(idSchema).min(1).max(1_000).parse(ids), inventoryPatchSchema.parse(patch)))
  ipcMain.handle(IPC.plansList, () => repository.plans())
  ipcMain.handle(IPC.plansGet, (_event, id) => repository.plan(idSchema.parse(id)))
  ipcMain.handle(IPC.plansSave, (_event, name, tree) => repository.savePlan(z.string().trim().min(1).max(120).parse(name), z.custom<BreedingPlanTree>((value) => Boolean(value && typeof value === 'object')).parse(tree)))
  ipcMain.handle(IPC.plansDelete, (_event, id) => repository.deletePlan(idSchema.parse(id)))
  ipcMain.handle(IPC.plansCompleteStep, (_event, input) => {
    const parsed = completeStepSchema.parse(input)
    backup.safetySnapshot(`before-breed-${parsed.planId}-${parsed.stepId}`)
    return repository.completeStep(parsed)
  })
  ipcMain.handle(IPC.plansReplaceMissing, (_event, planId, missingId, pokemonId) => repository.replaceMissing(idSchema.parse(planId), z.string().min(1).max(100).parse(missingId), idSchema.parse(pokemonId)))
  ipcMain.handle(IPC.dashboardStats, () => repository.dashboard())
  ipcMain.handle(IPC.historyList, () => repository.history())
  ipcMain.handle(IPC.backupCreate, (_event, path) => backup.create(pathSchema.parse(path)))
  ipcMain.handle(IPC.backupRestore, (_event, path) => { backup.restore(pathSchema.parse(path)); cloud?.markDirty() })
  ipcMain.handle(IPC.backupUndoLast, () => { const restored = backup.restoreLatestSafetySnapshot(); cloud?.markDirty(); return restored })
  ipcMain.handle(IPC.exportJson, (_event, path) => {
    const destination = pathSchema.parse(path); writeFileSync(destination, `${JSON.stringify(repository.exportData(), null, 2)}\n`); return destination
  })
  ipcMain.handle(IPC.importJson, (_event, path) => {
    const source = pathSchema.parse(path); const data = JSON.parse(readFileSync(source, 'utf8')) as JsonExport
    backup.safetySnapshot('before-json-import'); repository.importData(data); return data
  })
  ipcMain.handle(IPC.dialogSave, async (_event, defaultPath, filters: FileFilter[]) => {
    const result = await dialog.showSaveDialog({ defaultPath: z.string().max(260).parse(defaultPath), filters })
    return result.canceled ? null : result.filePath
  })
  ipcMain.handle(IPC.dialogOpen, async (_event, filters: FileFilter[]) => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle(IPC.settingsGet, () => preferences.get())
  ipcMain.handle(IPC.settingsSet, (_event, key, value) => { const validKey = z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/).parse(key); preferences.set(validKey, value) })
  ipcMain.handle(IPC.cloudGetState, () => cloud?.state())
  ipcMain.handle(IPC.cloudConnect, () => cloud?.connect())
  ipcMain.handle(IPC.cloudDisconnect, () => cloud?.disconnect())
  ipcMain.handle(IPC.cloudUpload, () => cloud?.upload())
  ipcMain.handle(IPC.cloudListBackups, () => cloud?.listBackups())
  ipcMain.handle(IPC.cloudRestore, async (_event, fileId) => {
    const validId = z.string().regex(/^[A-Za-z0-9_-]{10,200}$/).parse(fileId)
    if (!cloud) throw new Error('Cloud backup service is unavailable')
    const result = await cloud.restore(validId)
    setTimeout(() => { app.relaunch(); app.exit(0) }, 750)
    return result
  })
  ipcMain.handle(IPC.devLoadDataset, () => {
    if (!development) throw new Error('Development dataset is disabled in packaged builds')
    if (!repository.boxes().some((box) => box.name === 'Development Seed')) repository.createBox('Development Seed')
    const box = repository.boxes().find((entry) => entry.name === 'Development Seed')
    if (box && repository.inventory({ boxId: box.id }).length > 0) return 0
    const speciesIds = [4, 7, 19, 29, 32, 41, 54, 66, 74, 81, 92, 111, 129, 147, 179, 194, 246, 280, 304, 328, 333, 349, 371, 374, 443]
    const inputs: InventoryInput[] = Array.from({ length: 50 }, (_, index) => {
      const speciesId = speciesIds[index % speciesIds.length] as number
      const genders = rules.selectableGenders(speciesId)
      const gender = genders[index % genders.length] as InventoryInput['gender']
      return {
        speciesId, gender,
        ivs: { hp: index % 6 === 0 ? 31 : (index * 7) % 32, atk: index % 6 === 1 ? 31 : (index * 11) % 32, def: index % 6 === 2 ? 31 : (index * 13) % 32, spAtk: index % 6 === 3 ? 31 : (index * 17) % 32, spDef: index % 6 === 4 ? 31 : (index * 19) % 32, speed: index % 6 === 5 ? 31 : (index * 23) % 32 },
        nature: index % 3 === 0 ? 'Jolly' : index % 3 === 1 ? 'Adamant' : 'Modest', alpha: index < 40, ha: index % 3 === 0,
        boxId: box?.id ?? null, notes: 'Development-only deterministic seed'
      }
    })
    return repository.bulkCreatePokemon(inputs).length
  })
  ipcMain.handle(IPC.appInfo, () => ({ version: app.getVersion(), development, databasePath: database.path, settingsPath: preferences.path }))
  ipcMain.handle(IPC.spriteGet, (_event, speciesId) => sprites.get(idSchema.parse(speciesId)))
  ipcMain.handle(IPC.scannerSources, () => scanner.sources())
  ipcMain.handle(IPC.scannerPreview, (_event, sourceId) => scanner.preview(z.string().min(1).max(300).parse(sourceId)))
  ipcMain.handle(IPC.scannerScanCurrent, (_event, request) => scanner.scanCurrent(scannerScanRequestSchema.parse(request)))
  ipcMain.handle(IPC.scannerFingerprint, (_event, sourceId, calibration) => scanner.fingerprint(
    z.string().min(1).max(300).parse(sourceId), scannerCalibrationSchema.parse(calibration)
  ))
  ipcMain.handle(IPC.scannerSetHotkey, (_event, config) => {
    const parsed = scannerHotkeySchema.parse(config)
    if (hotkeyAccelerator) globalShortcut.unregister(hotkeyAccelerator)
    hotkeyAccelerator = null
    if (!parsed.enabled) return { registered: false, message: 'Manual capture hotkey disabled' }
    const registered = globalShortcut.register(parsed.accelerator, () => {
      if (hotkeyBusy) return
      hotkeyBusy = true
      void scanner.scanCurrent(parsed).then((result) => {
        mainWindow?.webContents.send(IPC.scannerCaptured, result)
        const name = SPECIES.find((entry) => entry.id === result.species.value)?.name ?? 'Pokémon'
        if (Notification.isSupported()) new Notification({ title: 'PokeMMO Box Scanner', body: `${name} captured · ${result.status}` }).show()
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        mainWindow?.webContents.send(IPC.scannerError, message)
        if (Notification.isSupported()) new Notification({ title: 'PokeMMO Box Scanner', body: `Capture failed: ${message}` }).show()
      })
        .finally(() => { hotkeyBusy = false })
    })
    if (registered) hotkeyAccelerator = parsed.accelerator
    return { registered, message: registered ? `${parsed.accelerator} is ready; it only triggers a local capture` : `${parsed.accelerator} is already used by another application` }
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1120, minHeight: 700, backgroundColor: '#0a0f19', show: false,
    webPreferences: { preload: join(dirname, '../preload/index.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  })
  mainWindow = window
  window.on('closed', () => { if (mainWindow === window) mainWindow = null })
  window.on('focus', () => { if (!window.webContents.isFocused()) window.webContents.focus() })
  if (development) {
    window.webContents.on('console-message', (_event, level, message) => console.log(`[renderer:${level}] ${message}`))
    window.webContents.on('preload-error', (_event, preloadPath, error) => console.error(`Preload error at ${preloadPath}`, error))
    window.webContents.on('did-fail-load', (_event, code, description, url) => console.error(`Renderer load failed ${code}: ${description} (${url})`))
  }
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://forums.pokemmo.com/') || url.startsWith('https://pokeapi.co/')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData'); mkdirSync(userData, { recursive: true })
  database = new AppDatabase(join(userData, 'data', 'planner.sqlite'))
  repository = new AppRepository(database, () => cloud?.markDirty())
  preferences = new IniSettings(join(userData, 'settings.ini'), repository.settings())
  repository.clearSettingsPrefix('scanner.')
  backup = new BackupService(database, app.getVersion(), join(userData, 'safety-snapshots'))
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || __GOOGLE_OAUTH_CLIENT_ID__.trim()
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || __GOOGLE_OAUTH_CLIENT_SECRET__.trim()
  const tokenStore = new EncryptedRefreshTokenStore(join(userData, 'cloud', 'google-token.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value)
  })
  const oauth = new GoogleOAuthService(clientId, tokenStore, (url) => shell.openExternal(url), fetch, 180_000, clientSecret)
  const drive = new GoogleDriveService(oauth)
  cloud = new CloudBackupService(oauth, drive, backup, new CloudStateStore(join(userData, 'cloud', 'state.json')))
  cloud.onChange((state) => mainWindow?.webContents.send(IPC.cloudChanged, state))
  sprites = new SpriteProvider(join(userData, 'sprite-cache'))
  const language = app.isPackaged ? { langPath: join(process.resourcesPath, 'ocr'), gzip: true } : eng
  scanner = new ScannerService(new RecognitionEngine(language, join(userData, 'scanner-debug')), SPECIES)
  registerIpc()
  const scannerSmokeImage = process.env.POKEMMO_PLANNER_SCANNER_SMOKE_IMAGE
  const scannerSmokeOutput = process.env.POKEMMO_PLANNER_SCANNER_SMOKE_OUTPUT
  if (scannerSmokeImage && scannerSmokeOutput) {
    try {
      const result = await scanner.scanImageForSmokeTest(readFileSync(scannerSmokeImage), DEFAULT_SCANNER_CALIBRATION)
      writeFileSync(scannerSmokeOutput, `${JSON.stringify(result, null, 2)}\n`)
    } catch (error) {
      writeFileSync(scannerSmokeOutput, `${JSON.stringify({ error: error instanceof Error ? error.stack ?? error.message : String(error) }, null, 2)}\n`)
    }
    app.quit()
    return
  }
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = development
      ? "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  createWindow()
  void cloud.initialize()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => { globalShortcut.unregisterAll(); void scanner?.dispose() })
app.on('before-quit', () => { try { database?.close() } catch { /* already closed */ } })
