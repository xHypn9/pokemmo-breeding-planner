import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SPECIES } from '../src/data/species'

const requestedPath = process.argv.slice(2).find((argument) => argument.toLowerCase().endsWith('.sqlite'))
const path = resolve(requestedPath ?? 'development-data/planner.sqlite')
mkdirSync(dirname(path), { recursive: true })
const database = new DatabaseSync(path)
database.exec(readFileSync(resolve('src/main/database/migrations/001_initial.sql'), 'utf8'))
const timestamp = new Date().toISOString()
const speciesStatement = database.prepare('INSERT OR REPLACE INTO pokemon_species(id,name,slug,egg_groups_json,metadata_json) VALUES(?,?,?,?,?)')
for (const species of SPECIES) speciesStatement.run(species.id, species.name, species.slug, JSON.stringify(species.eggGroups), JSON.stringify(species))
database.prepare('INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(1,?,?)').run('initial', timestamp)
database.prepare('INSERT OR IGNORE INTO boxes(name,created_at) VALUES(?,?)').run('Development Seed', timestamp)
const box = database.prepare('SELECT id FROM boxes WHERE name=?').get('Development Seed') as { id: number }
const insert = database.prepare(`INSERT INTO pokemon_inventory(species_id,gender,hp,atk,def,sp_atk,sp_def,speed,nature,alpha,ha,box_id,notes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
for (let index = 0; index < 50; index += 1) insert.run(
  443, index % 2 ? 'Male' : 'Female', index % 6 === 0 ? 31 : index % 32, index % 6 === 1 ? 31 : index % 32,
  index % 6 === 2 ? 31 : index % 32, index % 6 === 3 ? 31 : index % 32, index % 6 === 4 ? 31 : index % 32,
  index % 6 === 5 ? 31 : index % 32, index % 2 ? 'Jolly' : 'Adamant', 1, index % 3 === 0 ? 1 : 0,
  box.id, 'Development-only seed', 'Available', timestamp, timestamp
)
database.close()
console.log(`Seeded ${path}`)
