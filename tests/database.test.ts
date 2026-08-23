import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BreedingPlanner } from '../src/domain/breeding'
import { AppDatabase } from '../src/main/database/Database'
import { AppRepository } from '../src/main/database/Repository'
import { BackupService } from '../src/main/services/BackupService'
import type { BreedingTarget, InventoryInput } from '../src/shared/types'
import { ivs } from './helpers'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('SQLite repositories and atomic breed completion', () => {
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

  it('migrates, reserves parents, consumes them and creates the guaranteed child', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pbp-db-test-')); directories.push(directory)
    const database = new AppDatabase(join(directory, 'test.sqlite')); const repository = new AppRepository(database)
    const box = repository.createBox('Alpha 1')
    const exact = ivs({ hp: 31, atk: 31, def: 31, spAtk: 15, spDef: 31, speed: 31 })
    const base = (gender: 'Female' | 'Male', nature: 'Jolly' | 'Adamant', ha: boolean): InventoryInput => ({ speciesId: 443, gender, ivs: exact, nature, alpha: true, ha, boxId: box.id, notes: '' })
    repository.createPokemon(base('Female', 'Jolly', true)); repository.createPokemon(base('Male', 'Adamant', false))
    const target: BreedingTarget = { speciesId: 445, ivs: exact, nature: 'Jolly', alpha: 'Alpha', ha: 'Yes', optimizer: 'balanced' }
    const tree = new BreedingPlanner().calculate(repository.inventory({ status: 'Available' }), target, { maxStates: 1_000 })
    const saved = repository.savePlan('Garchomp test', tree)
    expect(repository.inventory().filter((pokemon) => pokemon.status === 'Reserved')).toHaveLength(2)
    const complete = repository.completeStep({ planId: saved.id, stepId: tree.steps[0]!.id })
    expect(complete.status).toBe('Completed')
    expect(repository.inventory().filter((pokemon) => pokemon.status === 'Consumed')).toHaveLength(2)
    const child = repository.inventory().find((pokemon) => pokemon.status === 'Available')
    expect(child?.speciesId).toBe(443)
    expect(child?.ivs).toEqual(exact)
    expect(child?.nature).toBe('Jolly')
    expect(child?.alpha).toBe(true)
    expect(child?.ha).toBe(true)
    expect(repository.history().length).toBeGreaterThanOrEqual(6)
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
