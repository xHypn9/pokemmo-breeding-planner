import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CloudBackupEntry, CloudBackupState } from '../../shared/ipc'
import type { DriveBackupFile, DriveBackupMetadata } from './GoogleDriveService'

export interface CloudAuthPort { isConfigured(): boolean; isConnected(): boolean; connect(): Promise<void>; disconnect(): Promise<void> }
export interface CloudDrivePort { listBackups(): Promise<DriveBackupFile[]>; upload(path: string, name: string, metadata: DriveBackupMetadata): Promise<DriveBackupFile>; download(fileId: string, destination: string): Promise<void>; delete(fileId: string): Promise<void> }
export interface BackupPort { create(destination: string): string; inspect(source: string): { appVersion: string; schemaVersion: number; createdAt: string }; restore(source: string): void }

interface PersistedCloudState { dirty: boolean; lastUploadAt: string | null; lastUploadFileId: string | null }

export class CloudStateStore {
  constructor(readonly path: string) {}
  load(): PersistedCloudState {
    if (!existsSync(this.path)) return { dirty: true, lastUploadAt: null, lastUploadFileId: null }
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PersistedCloudState>
      return { dirty: value.dirty !== false, lastUploadAt: typeof value.lastUploadAt === 'string' ? value.lastUploadAt : null, lastUploadFileId: typeof value.lastUploadFileId === 'string' ? value.lastUploadFileId : null }
    } catch { return { dirty: true, lastUploadAt: null, lastUploadFileId: null } }
  }
  save(value: PersistedCloudState): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(`${this.path}.tmp`, this.path)
  }
}

export class CloudBackupService {
  private readonly listeners = new Set<(state: CloudBackupState) => void>()
  private persisted: PersistedCloudState
  private busy: CloudBackupState['busy'] = 'idle'
  private lastError: string | null = null
  private remoteCount = 0

  constructor(private readonly auth: CloudAuthPort, private readonly drive: CloudDrivePort, private readonly backup: BackupPort, private readonly stateStore: CloudStateStore) {
    this.persisted = stateStore.load()
  }

  state(): CloudBackupState {
    return { connected: this.auth.isConnected(), configured: this.auth.isConfigured(), dirty: this.persisted.dirty, busy: this.busy, lastUploadAt: this.persisted.lastUploadAt, lastUploadFileId: this.persisted.lastUploadFileId, lastError: this.lastError, remoteBackupCount: this.remoteCount }
  }

  onChange(listener: (state: CloudBackupState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  async initialize(): Promise<void> {
    if (!this.auth.isConnected()) return
    try { this.remoteCount = (await this.drive.listBackups()).length; this.lastError = null } catch (error) { this.lastError = message(error) }
    this.emit()
  }

  markDirty(): void {
    if (this.persisted.dirty) return
    this.persisted.dirty = true
    this.persist(); this.emit()
  }

  async connect(): Promise<CloudBackupState> {
    await this.operation('connecting', async () => {
      await this.auth.connect()
      const backups = await this.drive.listBackups()
      this.remoteCount = backups.length
    })
    return this.state()
  }

  async disconnect(): Promise<CloudBackupState> {
    await this.operation('disconnecting', async () => {
      await this.auth.disconnect(); this.remoteCount = 0
      this.persisted.lastUploadAt = null; this.persisted.lastUploadFileId = null; this.persisted.dirty = true; this.persist()
    })
    return this.state()
  }

  async upload(): Promise<CloudBackupState> {
    await this.operation('uploading', async () => {
      this.requireConnected()
      const work = mkdtempSync(join(tmpdir(), 'pbp-cloud-upload-'))
      try {
        const path = join(work, 'backup.zip')
        this.backup.create(path)
        const manifest = this.backup.inspect(path)
        const name = `PokeMMO-Breeding-Planner-${new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z')}.zip`
        const uploaded = await this.drive.upload(path, name, { appVersion: manifest.appVersion, schemaVersion: manifest.schemaVersion })
        this.persisted = { dirty: false, lastUploadAt: uploaded.createdTime, lastUploadFileId: uploaded.id }; this.persist()
        const backups = await this.drive.listBackups(); this.remoteCount = backups.length
        const obsolete = backups.slice(10)
        for (const old of obsolete) await this.drive.delete(old.id)
        this.remoteCount = Math.min(10, backups.length)
      } finally { rmSync(work, { recursive: true, force: true }) }
    })
    return this.state()
  }

  async listBackups(): Promise<CloudBackupEntry[]> {
    this.requireConnected()
    try {
      const files = await this.drive.listBackups(); this.remoteCount = files.length; this.lastError = null; this.emit()
      return files.slice(0, 10).map(toEntry)
    } catch (error) {
      this.lastError = message(error); this.emit(); throw new Error(this.lastError)
    }
  }

  async restore(fileId: string): Promise<{ state: CloudBackupState; manifest: { appVersion: string; schemaVersion: number; createdAt: string } }> {
    const manifest = await this.operation('restoring', async () => {
      this.requireConnected()
      const work = mkdtempSync(join(tmpdir(), 'pbp-cloud-restore-'))
      try {
        const path = join(work, 'backup.zip')
        await this.drive.download(fileId, path)
        const manifest = this.backup.inspect(path)
        this.backup.restore(path)
        this.persisted = { dirty: false, lastUploadAt: manifest.createdAt, lastUploadFileId: fileId }; this.persist()
        return manifest
      } finally { rmSync(work, { recursive: true, force: true }) }
    })
    return { state: this.state(), manifest }
  }

  private async operation<T>(busy: Exclude<CloudBackupState['busy'], 'idle'>, action: () => Promise<T>): Promise<T> {
    if (this.busy !== 'idle') throw new Error('Another Google Drive operation is already in progress')
    this.busy = busy; this.lastError = null; this.emit()
    try { return await action() }
    catch (error) { this.lastError = message(error); throw new Error(this.lastError) }
    finally { this.busy = 'idle'; this.emit() }
  }

  private requireConnected(): void { if (!this.auth.isConnected()) throw new Error('Google Drive is not connected') }
  private persist(): void { this.stateStore.save(this.persisted) }
  private emit(): void { const state = this.state(); for (const listener of this.listeners) listener(state) }
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const toEntry = (file: DriveBackupFile): CloudBackupEntry => ({ id: file.id, name: file.name, createdAt: file.createdTime, size: file.size, appVersion: file.appVersion, schemaVersion: file.schemaVersion })
