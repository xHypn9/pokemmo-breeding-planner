import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import AdmZip from 'adm-zip'
import { APP_SCHEMA_VERSION } from '../../shared/constants'
import { AppDatabase } from '../database/Database'

interface BackupManifest { format: 'PokeMMO Breeding Planner Backup'; schemaVersion: number; createdAt: string; appVersion: string }

const stamp = () => new Date().toISOString().replaceAll(':', '-')

export class BackupService {
  constructor(private readonly database: AppDatabase, private readonly appVersion: string, private readonly safetyDirectory: string) {
    mkdirSync(safetyDirectory, { recursive: true })
  }

  create(destination: string): string {
    mkdirSync(dirname(destination), { recursive: true })
    const work = mkdtempSync(join(tmpdir(), 'pbp-backup-'))
    try {
      const snapshot = join(work, 'database.sqlite')
      this.database.snapshot(snapshot)
      const manifest: BackupManifest = { format: 'PokeMMO Breeding Planner Backup', schemaVersion: APP_SCHEMA_VERSION, createdAt: new Date().toISOString(), appVersion: this.appVersion }
      const zip = new AdmZip()
      zip.addLocalFile(snapshot, '', 'database.sqlite')
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
      zip.writeZip(destination)
      return destination
    } finally { rmSync(work, { recursive: true, force: true }) }
  }

  safetySnapshot(label: string): string {
    const path = join(this.safetyDirectory, `${stamp()}-${label.replace(/[^a-z0-9-]/gi, '_')}.sqlite`)
    this.database.snapshot(path)
    const files = readdirSync(this.safetyDirectory).map((name) => join(this.safetyDirectory, name))
      .filter((entry) => entry.endsWith('.sqlite')).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    for (const old of files.slice(20)) rmSync(old, { force: true })
    return path
  }

  restore(source: string): void {
    const zip = new AdmZip(source)
    const manifestEntry = zip.getEntry('manifest.json'); const databaseEntry = zip.getEntry('database.sqlite')
    if (!manifestEntry || !databaseEntry) throw new Error('Backup is missing manifest.json or database.sqlite')
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as BackupManifest
    if (manifest.format !== 'PokeMMO Breeding Planner Backup') throw new Error('Not a PokeMMO Breeding Planner backup')
    if (manifest.schemaVersion > APP_SCHEMA_VERSION) throw new Error(`Backup schema ${manifest.schemaVersion} is newer than this app supports`)
    const work = mkdtempSync(join(tmpdir(), 'pbp-restore-'))
    const extracted = join(work, 'database.sqlite')
    try {
      writeFileSync(extracted, databaseEntry.getData())
      this.validateDatabase(extracted, manifest.schemaVersion)
      this.safetySnapshot('before-restore')
      this.replaceDatabase(extracted)
    } catch (error) {
      try { this.database.db.prepare('SELECT 1').get() } catch { this.database.reopen() }
      throw error
    } finally { rmSync(work, { recursive: true, force: true }) }
  }

  restoreLatestSafetySnapshot(): string {
    const source = readdirSync(this.safetyDirectory).map((name) => join(this.safetyDirectory, name))
      .filter((entry) => entry.endsWith('.sqlite')).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    if (!source) throw new Error('No automatic safety snapshot is available')
    this.validateDatabase(source, APP_SCHEMA_VERSION)
    this.replaceDatabase(source)
    renameSync(source, `${source}.restored`)
    return source
  }

  inspect(source: string): BackupManifest {
    const zip = new AdmZip(source); const entry = zip.getEntry('manifest.json')
    if (!entry) throw new Error(`Backup ${basename(source)} has no manifest`)
    return JSON.parse(entry.getData().toString('utf8')) as BackupManifest
  }

  private validateDatabase(source: string, expectedVersion: number): void {
    const probe = new DatabaseSync(source, { readOnly: true })
    try {
      const row = probe.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }
      if (!row || Number(row.version) !== expectedVersion) throw new Error('Backup database schema does not match the expected version')
      const integrity = probe.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
      if (integrity.integrity_check !== 'ok') throw new Error(`Backup database failed integrity check: ${integrity.integrity_check ?? 'unknown result'}`)
    } finally { probe.close() }
  }

  private replaceDatabase(source: string): void {
    const staged = `${this.database.path}.restore-new`
    const rollback = `${this.database.path}.restore-old`
    for (const path of [staged, rollback]) if (existsSync(path)) rmSync(path, { force: true })
    copyFileSync(source, staged)
    let closed = false; let previousMoved = false; let replacementMoved = false
    try {
      this.database.checkpoint()
      this.database.close(); closed = true
      for (const suffix of ['-wal', '-shm']) if (existsSync(`${this.database.path}${suffix}`)) rmSync(`${this.database.path}${suffix}`, { force: true })
      if (existsSync(this.database.path)) { renameSync(this.database.path, rollback); previousMoved = true }
      renameSync(staged, this.database.path); replacementMoved = true
      this.database.reopen()
      closed = false
      if (previousMoved && existsSync(rollback)) rmSync(rollback, { force: true })
    } catch (error) {
      if (closed) {
        if (replacementMoved && existsSync(this.database.path)) rmSync(this.database.path, { force: true })
        if (previousMoved && existsSync(rollback)) renameSync(rollback, this.database.path)
        this.database.reopen()
      }
      throw error
    } finally { if (existsSync(staged)) rmSync(staged, { force: true }) }
  }
}
