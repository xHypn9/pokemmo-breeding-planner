import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SPECIES } from '../../data/species'
import migration001 from './migrations/001_initial.sql?raw'
import migration002 from './migrations/002_breeding_enabled.sql?raw'
import migration003 from './migrations/003_remove_consumed.sql?raw'

const now = () => new Date().toISOString()
const escapeSqlString = (value: string) => value.replaceAll("'", "''")

export class AppDatabase {
  private connection: DatabaseSync

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.connection = this.open()
    this.migrate()
    this.seedSpecies()
  }

  get db(): DatabaseSync { return this.connection }

  private open(): DatabaseSync {
    const database = new DatabaseSync(this.path)
    database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;')
    return database
  }

  private migrate(): void {
    this.connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
    const row = this.connection.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(1) as { version: number } | undefined
    if (!row) this.transaction(() => {
      this.connection.exec(migration001)
      this.connection.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(1, 'initial', now())
    })
    const row002 = this.connection.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(2) as { version: number } | undefined
    if (!row002) this.transaction(() => {
      this.connection.exec(migration002)
      this.connection.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(2, 'breeding-enabled', now())
    })
    const row003 = this.connection.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(3) as { version: number } | undefined
    if (!row003) {
      const consumed = this.connection.prepare("SELECT COUNT(*) AS count FROM pokemon_inventory WHERE status='Consumed'").get() as { count: number }
      if (consumed.count > 0) this.snapshot(join(dirname(this.path), `before-consumed-cleanup-${randomUUID()}.sqlite`))
      this.transaction(() => {
        this.connection.exec(migration003)
        this.connection.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(3, 'remove-consumed-inventory', now())
      })
    }
  }

  private seedSpecies(): void {
    const count = this.connection.prepare('SELECT COUNT(*) AS count FROM pokemon_species').get() as { count: number }
    if (count.count === SPECIES.length) return
    const statement = this.connection.prepare(`
      INSERT INTO pokemon_species(id, name, slug, egg_groups_json, metadata_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, slug=excluded.slug,
        egg_groups_json=excluded.egg_groups_json, metadata_json=excluded.metadata_json
    `)
    this.transaction(() => {
      for (const species of SPECIES) statement.run(species.id, species.name, species.slug, JSON.stringify(species.eggGroups), JSON.stringify(species))
    })
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.connection.exec('COMMIT')
      return result
    } catch (error) {
      this.connection.exec('ROLLBACK')
      throw error
    }
  }

  checkpoint(): void { this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)') }

  snapshot(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true })
    this.checkpoint()
    this.connection.exec(`VACUUM INTO '${escapeSqlString(destination)}'`)
  }

  close(): void { this.connection.close() }

  reopen(): void {
    this.connection = this.open()
    this.migrate()
    this.seedSpecies()
  }
}
