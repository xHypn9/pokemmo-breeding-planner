import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BreedingPlanner } from '../src/domain/breeding'
import { AppDatabase } from '../src/main/database/Database'
import { AppRepository } from '../src/main/database/Repository'
import { BackupService } from '../src/main/services/BackupService'
import { STATS } from '../src/shared/constants'
import type { BreedingTarget, InventoryInput, SavedPlan, Stat } from '../src/shared/types'
import { ivs } from './helpers'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('SQLite repositories and atomic breed completion', () => {
  it('reports persistent user-data changes through the centralized repository hook', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-dirty-hook-test-')); directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite')); let changes = 0
    const repository = new AppRepository(database, () => { changes++ })
    repository.createBox('Cloud dirty test')
    expect(changes).toBe(1)
    repository.setSetting('scanner.hotkey', 'F2')
    expect(changes).toBe(1)
    repository.clearSettingsPrefix('scanner.')
    expect(repository.settings()).toEqual({})
    database.close()
  })

  it('persists saved plans and reservations across restart, then releases parents when deleted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-reserved-test-')); directories.push(directory)
    const path = join(directory, 'test.sqlite')
    let database = new AppDatabase(path); let repository = new AppRepository(database)
    const base: InventoryInput = { speciesId: 443, gender: 'Female', ivs: ivs({ hp: 31 }), nature: 'Hardy', alpha: false, ha: false, boxId: null, notes: '' }
    const a = repository.createPokemon(base); const b = repository.createPokemon({ ...base, gender: 'Male' })
    const target: BreedingTarget = { speciesId: 445, ivs: { hp: 31, atk: null, def: null, spAtk: null, spDef: null, speed: null }, nature: null, alpha: 'Any', ha: 'Any', optimizer: 'balanced' }
    const tree = new BreedingPlanner().calculate(repository.inventory(), target)
    const saved = repository.savePlan('Persistent plan', tree)
    database.close()
    database = new AppDatabase(path); repository = new AppRepository(database)
    expect(repository.plan(saved.id).tree).toEqual(saved.tree)
    expect(repository.inventoryById(a.id).status).toBe('Reserved')
    expect(repository.inventoryById(b.id).status).toBe('Reserved')
    expect(new BreedingPlanner().calculate(repository.inventory(), target).inventoryIds).toEqual([])
    expect(() => repository.savePlan('Duplicate', tree)).toThrow('no longer available')
    repository.deletePlan(saved.id)
    expect(repository.inventory().every((entry) => entry.status === 'Available')).toBe(true)
    database.close()
  })
  it('migrates existing schema-v1 inventory as breeding-enabled', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-v1-migration-test-')); directories.push(directory)
    const path = join(directory, 'test.sqlite')
    const original = new AppDatabase(path); const repository = new AppRepository(original)
    const pokemon = repository.createPokemon({
      speciesId: 443, gender: 'Male', ivs: ivs({ hp: 31 }), nature: 'Hardy', alpha: false, ha: false,
      boxId: null, notes: 'Legacy record'
    })
    original.db.exec('ALTER TABLE pokemon_inventory DROP COLUMN breeding_enabled; DELETE FROM schema_migrations WHERE version IN (2,3);')
    original.close()

    const migrated = new AppDatabase(path); const migratedRepository = new AppRepository(migrated)
    expect(migratedRepository.inventoryById(pokemon.id).breedingEnabled).toBe(true)
    const schema = migrated.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
    expect(schema.version).toBe(3)
    migrated.close()
  })

  it('keeps an Unavailable Pokémon in inventory while excluding it from breeding', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-availability-test-')); directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite')); const repository = new AppRepository(database)
    const box = repository.createBox('Do not breed')
    const exact = ivs({ hp: 31, atk: 31, def: 31, spAtk: 31, spDef: 31, speed: 31 })
    const pokemon = repository.createPokemon({
      speciesId: 443, gender: 'Female', ivs: exact, nature: 'Jolly', alpha: true, ha: true,
      boxId: box.id, notes: 'Keep for another purpose'
    })
    const target: BreedingTarget = { speciesId: 445, ivs: exact, nature: 'Jolly', alpha: 'Alpha', ha: 'Yes', optimizer: 'balanced' }
    const matchingTree = new BreedingPlanner().calculate(repository.inventory(), target, { maxStates: 1_000 })
    expect(matchingTree.inventoryIds).toContain(pokemon.id)

    const disabled = repository.updatePokemon(pokemon.id, { breedingEnabled: false })
    expect(disabled.status).toBe('Available')
    expect(disabled.breedingEnabled).toBe(false)
    expect(repository.inventory({ breedingEnabled: false }).map((entry) => entry.id)).toEqual([pokemon.id])
    expect(repository.dashboard().available).toBe(0)
    const excludedTree = new BreedingPlanner().calculate(repository.inventory(), target, { maxStates: 1_000 })
    expect(excludedTree.inventoryIds).not.toContain(pokemon.id)
    expect(excludedTree.missingBreeders.length).toBeGreaterThan(0)
    expect(() => repository.savePlan('Stale plan', matchingTree)).toThrow('no longer available for breeding')

    const enabled = repository.updatePokemon(pokemon.id, { breedingEnabled: true })
    expect(enabled.breedingEnabled).toBe(true)
    expect(repository.dashboard().available).toBe(1)
    const schema = database.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }
    expect(schema.version).toBe(3)
    database.close()
  })

  it('imports a mixed scanner batch including non-breedable Pokémon for inventory tracking', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-inventory-test-')); directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite')); const repository = new AppRepository(database)
    const box = repository.createBox('Complete collection')
    const scanned = [
      { speciesId: 30, gender: 'Female' }, { speciesId: 31, gender: 'Female' },
      { speciesId: 36, gender: 'Female' }, { speciesId: 36, gender: 'Male' },
      { speciesId: 54, gender: 'Male' }, { speciesId: 59, gender: 'Male' }
    ] as const
    const imported = repository.bulkCreatePokemon(scanned.map(({ speciesId, gender }): InventoryInput => ({
      speciesId, gender, ivs: ivs({ hp: 31 }), nature: 'Naughty', alpha: true, ha: true, boxId: box.id, notes: 'Scanner import'
    })))
    expect(imported.map((pokemon) => pokemon.speciesId)).toEqual([30, 31, 36, 36, 54, 59])
    expect(imported.every((pokemon) => pokemon.boxName === 'Complete collection')).toBe(true)
    database.close()
  })

  it('persists minimum target modes and accepts a higher-IV missing replacement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-minimum-test-')); directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite')); const repository = new AppRepository(database)
    const box = repository.createBox('Minimum IV test')
    const target: BreedingTarget = {
      speciesId: 445,
      ivs: { hp: 25, atk: null, def: null, spAtk: null, spDef: null, speed: null },
      ivExact: { hp: false }, nature: 'Jolly', alpha: 'Alpha', ha: 'Yes', optimizer: 'balanced'
    }
    const tree = new BreedingPlanner().calculate([], target, { maxStates: 1, maxRounds: 1 })
    const saved = repository.savePlan('Minimum target', tree)
    const minimum = saved.tree.missingBreeders.find((constraint) => constraint.minimumIvs?.hp === 25)
    expect(saved.target.ivExact?.hp).toBe(false)
    expect(minimum).toBeDefined()
    if (!minimum) throw new Error('Expected a minimum-IV missing constraint')
    const replacement = repository.createPokemon({
      speciesId: 443, gender: minimum.gender, ivs: ivs({ hp: 29 }), nature: minimum.nature ?? 'Hardy',
      alpha: minimum.alpha, ha: minimum.ha === true, boxId: box.id, notes: ''
    })
    const updated = repository.replaceMissing(saved.id, minimum.id, replacement.id)
    expect(updated.target.ivExact?.hp).toBe(false)
    expect(updated.tree.nodes.find((node) => node.id === minimum.id)?.inventoryId).toBe(replacement.id)
    expect(repository.inventoryById(replacement.id).status).toBe('Reserved')
    database.close()
  })

  it('migrates, reserves parents, removes them and creates the guaranteed child', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-db-test-')); directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite')); const repository = new AppRepository(database)
    const box = repository.createBox('Alpha 1')
    const exact = ivs({ hp: 31, atk: 31, def: 31, spAtk: 15, spDef: 31, speed: 31 })
    const base = (gender: 'Female' | 'Male', nature: 'Jolly' | 'Adamant', ha: boolean): InventoryInput => ({ speciesId: 443, gender, ivs: exact, nature, alpha: true, ha, boxId: box.id, notes: '' })
    const parentA = repository.createPokemon(base('Female', 'Jolly', true)); const parentB = repository.createPokemon(base('Male', 'Adamant', false))
    const target: BreedingTarget = { speciesId: 445, ivs: exact, nature: 'Jolly', alpha: 'Alpha', ha: 'Yes', optimizer: 'balanced' }
    const tree = new BreedingPlanner().calculate(repository.inventory({ status: 'Available' }), target, { maxStates: 1_000 })
    const saved = repository.savePlan('Garchomp test', tree)
    expect(repository.inventory().filter((pokemon) => pokemon.status === 'Reserved')).toHaveLength(2)
    const complete = repository.completeStep({ planId: saved.id, stepId: tree.steps[0]!.id })
    expect(complete.status).toBe('Completed')
    expect(repository.inventory()).toHaveLength(1)
    expect(() => repository.inventoryById(parentA.id)).toThrow('not found')
    expect(() => repository.inventoryById(parentB.id)).toThrow('not found')
    const child = repository.inventory().find((pokemon) => pokemon.status === 'Available')
    expect(child?.speciesId).toBe(443)
    expect(child?.ivs).toEqual(exact)
    expect(child?.nature).toBe('Jolly')
    expect(child?.alpha).toBe(true)
    expect(child?.ha).toBe(true)
    expect(repository.history().length).toBeGreaterThanOrEqual(6)
    const legacyConsumed = repository.createPokemon(base('Male', 'Adamant', false))
    database.db.prepare("UPDATE pokemon_inventory SET status='Consumed' WHERE id=?").run(legacyConsumed.id)
    const legacyExport = { ...repository.exportData(), schemaVersion: 2 }
    const importedDatabase = new AppDatabase(join(directory, 'imported.sqlite'))
    const imported = new AppRepository(importedDatabase)
    imported.importData(legacyExport)
    expect(imported.inventory().map((pokemon) => pokemon.id)).toEqual([child!.id])
    expect(imported.plan(saved.id).tree.steps[0]?.status).toBe('Completed')
    importedDatabase.close()
    database.close()
  })

  it('backs up and removes legacy Consumed rows on upgrade without touching live Pokémon', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-consumed-migration-test-')); directories.push(directory)
    const path = join(directory, 'test.sqlite')
    const original = new AppDatabase(path); const repository = new AppRepository(original)
    const base: InventoryInput = { speciesId: 443, gender: 'Male', ivs: ivs({ hp: 31 }), nature: 'Hardy', alpha: false, ha: false, boxId: null, notes: '' }
    const consumed = repository.createPokemon(base)
    original.db.prepare("UPDATE pokemon_inventory SET status='Consumed' WHERE id=?").run(consumed.id)
    const available = repository.createPokemon(base)
    original.db.prepare('DELETE FROM schema_migrations WHERE version=3').run()
    original.close()

    const upgraded = new AppDatabase(path); const upgradedRepository = new AppRepository(upgraded)
    expect(() => upgradedRepository.inventoryById(consumed.id)).toThrow('not found')
    expect(upgradedRepository.inventoryById(available.id).status).toBe('Available')
    expect(() => upgradedRepository.createPokemon({ ...base, status: 'Consumed' })).toThrow('cannot be added')
    expect(() => upgradedRepository.updatePokemon(available.id, { status: 'Consumed' })).toThrow('cannot be kept')
    expect(readdirSync(directory).some((name) => name.startsWith('before-consumed-cleanup-') && name.endsWith('.sqlite'))).toBe(true)
    expect((upgraded.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version).toBe(3)
    upgraded.close()
  })

  it('continues a multi-step saved plan after each pair of parents is deleted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-multistep-consumption-test-')); directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite')); const repository = new AppRepository(database)
    const target: BreedingTarget = {
      speciesId: 445, ivs: { hp: 31, atk: 31, def: 31, spAtk: null, spDef: null, speed: null },
      nature: null, alpha: 'Any', ha: 'Any', optimizer: 'balanced'
    }
    const planner = new BreedingPlanner()
    const template = planner.calculate([], target, { maxStates: 1, maxRounds: 1 })
    for (const missing of template.missingBreeders) {
      const values = ivs()
      for (const [stat, value] of Object.entries(missing.requiredIvs)) values[stat as Stat] = value
      for (const [stat, value] of Object.entries(missing.minimumIvs ?? {})) values[stat as Stat] = Math.max(values[stat as Stat], value)
      repository.createPokemon({
        speciesId: 443, gender: missing.gender === 'Genderless' ? 'Female' : missing.gender,
        ivs: values, nature: missing.nature ?? 'Hardy', alpha: missing.alpha, ha: missing.ha === true,
        boxId: null, notes: ''
      })
    }
    const tree = planner.calculate(repository.inventory({ status: 'Available' }), target, { maxStates: 1, maxRounds: 1 })
    expect(tree.steps.length).toBeGreaterThan(1)
    expect(tree.missingBreeders).toHaveLength(0)
    let saved: SavedPlan = repository.savePlan('Multi-step', tree)
    while (saved.tree.steps.some((step) => step.status === 'Pending')) {
      const nodes = new Map(saved.tree.nodes.map((node) => [node.id, node]))
      const step = saved.tree.steps.find((entry) => entry.status === 'Pending' && [entry.parentAId, entry.parentBId].every((id) => {
        const node = nodes.get(id)
        return node?.inventoryId || node?.producedInventoryId
      }))
      expect(step).toBeDefined()
      const result = nodes.get(step!.resultNodeId)!
      const observedIvs = Object.fromEntries(STATS.filter((stat) => result.guaranteedIvs[stat] === null)
        .map((stat) => [stat, result.possibleIvs[stat][0]])) as Partial<Record<Stat, number>>
      saved = repository.completeStep({ planId: saved.id, stepId: step!.id, observedIvs, observedNature: result.nature ?? 'Hardy' })
      expect(repository.inventory({ status: 'Consumed' })).toHaveLength(0)
    }
    expect(saved.status).toBe('Completed')
    expect(repository.inventory()).toHaveLength(1)
    database.close()
  })

  it('creates and restores a validated single-file backup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-backup-test-')); directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite')); const repository = new AppRepository(database)
    const box = repository.createBox('Before backup')
    const backup = new BackupService(database, 'test', join(directory, 'safety'))
    const archive = join(directory, 'copy.pbpbackup'); backup.create(archive)
    expect(existsSync(archive)).toBe(true)
    repository.createBox('After backup')
    expect(repository.boxes()).toHaveLength(2)
    backup.restore(archive)
    expect(repository.boxes()).toEqual([box])
    expect(existsSync(join(directory, 'safety'))).toBe(true)
    database.close()
  })

  it('restores the latest automatic safety snapshot exactly once', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-safety-test-')); directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite')); const repository = new AppRepository(database)
    repository.createBox('Before protected action')
    const backup = new BackupService(database, 'test', join(directory, 'safety'))
    backup.safetySnapshot('before-breed-test')
    repository.createBox('Accidental change')
    expect(repository.boxes()).toHaveLength(2)
    backup.restoreLatestSafetySnapshot()
    expect(repository.boxes().map((box) => box.name)).toEqual(['Before protected action'])
    expect(() => backup.restoreLatestSafetySnapshot()).toThrow('No automatic safety snapshot')
    database.close()
  })
})
