import type { DatabaseSync } from 'node:sqlite'
import { APP_SCHEMA_VERSION, NATURES, STATS } from '../../shared/constants'
import type {
  BoxRecord, BreedingPlanTree, CompleteStepInput, DashboardStats, InventoryInput, InventoryPokemon,
  JsonExport, Nature, PlanNode, SavedPlan, SavedPlanSummary, Stat
} from '../../shared/types'
import { BreedingSimulator, PlanValidator, PokeMMORuleset } from '../../domain/breeding'
import { AppDatabase } from './Database'

const now = () => new Date().toISOString()
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T
const bool = (value: unknown) => Number(value) === 1

interface InventoryRow extends Record<string, unknown> {
  id: number; species_id: number; gender: InventoryPokemon['gender']; hp: number; atk: number; def: number;
  sp_atk: number; sp_def: number; speed: number; nature: Nature; alpha: number; ha: number;
  box_id: number | null; box_name?: string | null; notes: string; status: InventoryPokemon['status']; created_at: string; updated_at: string
  breeding_enabled: number
}

function inventoryFromRow(row: InventoryRow): InventoryPokemon {
  return {
    id: Number(row.id), speciesId: Number(row.species_id), gender: row.gender,
    ivs: { hp: Number(row.hp), atk: Number(row.atk), def: Number(row.def), spAtk: Number(row.sp_atk), spDef: Number(row.sp_def), speed: Number(row.speed) },
    nature: row.nature, alpha: bool(row.alpha), ha: bool(row.ha), boxId: row.box_id === null ? null : Number(row.box_id),
    boxName: row.box_name ?? null, notes: row.notes, status: row.status, breedingEnabled: bool(row.breeding_enabled), createdAt: row.created_at, updatedAt: row.updated_at
  }
}

export class AppRepository {
  private readonly rules = new PokeMMORuleset()
  private readonly simulator = new BreedingSimulator(this.rules)
  private readonly validator = new PlanValidator(this.rules, this.simulator)

  constructor(private readonly database: AppDatabase, private readonly onPersistentChange: () => void = () => undefined) {}
  private get db(): DatabaseSync { return this.database.db }

  boxes(): BoxRecord[] {
    return (this.db.prepare('SELECT id, name, created_at AS createdAt FROM boxes ORDER BY name COLLATE NOCASE').all() as unknown as BoxRecord[])
  }

  createBox(name: string): BoxRecord {
    const timestamp = now()
    const result = this.db.prepare('INSERT INTO boxes(name, created_at) VALUES (?, ?)').run(name.trim(), timestamp)
    this.log('box_added', 'box', String(result.lastInsertRowid), { name })
    return { id: Number(result.lastInsertRowid), name: name.trim(), createdAt: timestamp }
  }

  inventory(filters: Record<string, unknown> = {}): InventoryPokemon[] {
    const where: string[] = []; const values: Array<string | number> = []
    if (filters.status) { where.push('i.status = ?'); values.push(String(filters.status)) }
    if (typeof filters.breedingEnabled === 'boolean') { where.push('i.breeding_enabled = ?'); values.push(filters.breedingEnabled ? 1 : 0) }
    if (filters.speciesId) { where.push('i.species_id = ?'); values.push(Number(filters.speciesId)) }
    if (filters.boxId) { where.push('i.box_id = ?'); values.push(Number(filters.boxId)) }
    if (filters.gender) { where.push('i.gender = ?'); values.push(String(filters.gender)) }
    if (typeof filters.alpha === 'boolean') { where.push('i.alpha = ?'); values.push(filters.alpha ? 1 : 0) }
    if (typeof filters.ha === 'boolean') { where.push('i.ha = ?'); values.push(filters.ha ? 1 : 0) }
    if (filters.nature) { where.push('i.nature = ?'); values.push(String(filters.nature)) }
    if (filters.query) { where.push('(s.name LIKE ? OR i.notes LIKE ?)'); values.push(`%${String(filters.query)}%`, `%${String(filters.query)}%`) }
    if (filters.eggGroup) { where.push('s.egg_groups_json LIKE ?'); values.push(`%"${String(filters.eggGroup)}"%`) }
    if (Array.isArray(filters.iv31)) for (const stat of filters.iv31) {
      const column = ({ hp: 'hp', atk: 'atk', def: 'def', spAtk: 'sp_atk', spDef: 'sp_def', speed: 'speed' } as const)[stat as Stat]
      if (column) where.push(`i.${column} = 31`)
    }
    const sql = `SELECT i.*, b.name AS box_name FROM pokemon_inventory i JOIN pokemon_species s ON s.id=i.species_id LEFT JOIN boxes b ON b.id=i.box_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.status, s.name, i.id`
    return (this.db.prepare(sql).all(...values) as unknown as InventoryRow[]).map(inventoryFromRow)
  }

  inventoryById(id: number): InventoryPokemon {
    const row = this.db.prepare('SELECT i.*, b.name AS box_name FROM pokemon_inventory i LEFT JOIN boxes b ON b.id=i.box_id WHERE i.id=?').get(id) as InventoryRow | undefined
    if (!row) throw new Error(`Inventory Pokémon #${id} not found`)
    return inventoryFromRow(row)
  }

  createPokemon(input: InventoryInput, action = 'pokemon_added'): InventoryPokemon {
    if (input.status === 'Consumed') throw new Error('Consumed Pokémon cannot be added to inventory')
    const species = this.rules.species(input.speciesId)
    if (!this.rules.validateGender(input.speciesId, input.gender)) throw new Error(`${species.name} cannot have gender ${input.gender}`)
    for (const stat of STATS) if (!Number.isInteger(input.ivs[stat]) || input.ivs[stat] < 0 || input.ivs[stat] > 31) throw new Error(`${stat} must be an integer from 0 to 31`)
    if (!NATURES.includes(input.nature)) throw new Error(`Unknown nature ${input.nature}`)
    const timestamp = now()
    const result = this.db.prepare(`INSERT INTO pokemon_inventory(species_id,gender,hp,atk,def,sp_atk,sp_def,speed,nature,alpha,ha,box_id,notes,status,breeding_enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.speciesId, input.gender, input.ivs.hp, input.ivs.atk, input.ivs.def, input.ivs.spAtk, input.ivs.spDef, input.ivs.speed,
      input.nature, input.alpha ? 1 : 0, input.ha ? 1 : 0, input.boxId, input.notes, input.status ?? 'Available', input.breedingEnabled === false ? 0 : 1, timestamp, timestamp
    )
    this.log(action, 'pokemon', String(result.lastInsertRowid), input)
    return this.inventoryById(Number(result.lastInsertRowid))
  }

  bulkCreatePokemon(inputs: InventoryInput[]): InventoryPokemon[] {
    return this.database.transaction(() => inputs.map((input) => this.createPokemon(input, 'pokemon_imported')))
  }

  updatePokemon(id: number, patch: Partial<InventoryInput>): InventoryPokemon {
    if (patch.status === 'Consumed') throw new Error('Consumed Pokémon cannot be kept in inventory')
    const current = this.inventoryById(id)
    const breedingFields: Array<keyof InventoryInput> = ['speciesId', 'gender', 'ivs', 'nature', 'alpha', 'ha', 'status', 'breedingEnabled']
    if (current.status !== 'Available' && breedingFields.some((field) => patch[field] !== undefined)) {
      throw new Error(`${current.status} Pokémon #${id} cannot have breeding properties changed`)
    }
    const merged: InventoryInput = {
      speciesId: patch.speciesId ?? current.speciesId, gender: patch.gender ?? current.gender,
      ivs: { ...current.ivs, ...(patch.ivs ?? {}) }, nature: patch.nature ?? current.nature,
      alpha: patch.alpha ?? current.alpha, ha: patch.ha ?? current.ha,
      boxId: patch.boxId === undefined ? current.boxId : patch.boxId, notes: patch.notes ?? current.notes,
      status: patch.status ?? current.status, breedingEnabled: patch.breedingEnabled ?? current.breedingEnabled
    }
    this.db.prepare(`UPDATE pokemon_inventory SET species_id=?,gender=?,hp=?,atk=?,def=?,sp_atk=?,sp_def=?,speed=?,nature=?,alpha=?,ha=?,box_id=?,notes=?,status=?,breeding_enabled=?,updated_at=? WHERE id=?`).run(
      merged.speciesId, merged.gender, merged.ivs.hp, merged.ivs.atk, merged.ivs.def, merged.ivs.spAtk, merged.ivs.spDef, merged.ivs.speed,
      merged.nature, merged.alpha ? 1 : 0, merged.ha ? 1 : 0, merged.boxId, merged.notes, merged.status ?? 'Available', merged.breedingEnabled === false ? 0 : 1, now(), id
    )
    this.log('pokemon_modified', 'pokemon', String(id), patch)
    return this.inventoryById(id)
  }

  bulkUpdatePokemon(ids: number[], patch: Partial<InventoryInput>): void {
    this.database.transaction(() => { for (const id of ids) this.updatePokemon(id, patch) })
  }

  deletePokemon(id: number): void {
    const current = this.inventoryById(id)
    if (current.status === 'Reserved') throw new Error('Reserved Pokémon cannot be deleted; delete or recalculate its plan first')
    this.db.prepare('DELETE FROM pokemon_inventory WHERE id=?').run(id)
    this.log('pokemon_deleted', 'pokemon', String(id), current)
  }

  savePlan(name: string, tree: BreedingPlanTree): SavedPlan {
    const checked = this.validator.validate(tree)
    if (!checked.valid) throw new Error(`Plan rejected: ${checked.errors.join('; ')}`)
    return this.database.transaction(() => {
      for (const id of tree.inventoryIds) {
        const pokemon = this.inventoryById(id)
        if (pokemon.status !== 'Available' || !pokemon.breedingEnabled) throw new Error(`Inventory Pokémon #${id} is no longer available for breeding`)
      }
      const timestamp = now()
      const result = this.db.prepare(`INSERT INTO breeding_plans(name,status,target_json,plan_json,diagnostics_json,ruleset_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(name.trim(), 'Ready', JSON.stringify(tree.target), JSON.stringify(tree), JSON.stringify(tree.diagnostics), tree.rulesetVersion, timestamp, timestamp)
      const planId = Number(result.lastInsertRowid)
      for (const id of tree.inventoryIds) this.db.prepare("UPDATE pokemon_inventory SET status='Reserved',updated_at=? WHERE id=?").run(timestamp, id)
      this.persistPlanChildren(planId, tree)
      this.log('plan_created', 'plan', String(planId), { name, inventoryIds: tree.inventoryIds, missing: tree.missingBreeders.length })
      return this.plan(planId)
    })
  }

  plans(): SavedPlanSummary[] {
    const rows = this.db.prepare('SELECT id,name,status,target_json,created_at,updated_at FROM breeding_plans ORDER BY updated_at DESC').all() as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: Number(row.id), name: String(row.name), status: row.status as SavedPlanSummary['status'], target: parse(row.target_json), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }))
  }

  plan(id: number): SavedPlan {
    const row = this.db.prepare('SELECT * FROM breeding_plans WHERE id=?').get(id) as Record<string, unknown> | undefined
    if (!row) throw new Error(`Plan #${id} not found`)
    return {
      id: Number(row.id), name: String(row.name), status: row.status as SavedPlan['status'], target: parse(row.target_json),
      tree: parse(row.plan_json), diagnostics: parse(row.diagnostics_json), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    }
  }

  deletePlan(id: number): void {
    const saved = this.plan(id)
    this.database.transaction(() => {
      for (const inventoryId of saved.tree.inventoryIds) this.db.prepare("UPDATE pokemon_inventory SET status='Available',updated_at=? WHERE id=? AND status='Reserved'").run(now(), inventoryId)
      for (const node of saved.tree.nodes) if (node.producedInventoryId) this.db.prepare("UPDATE pokemon_inventory SET status='Available',updated_at=? WHERE id=? AND status='Reserved'").run(now(), node.producedInventoryId)
      this.db.prepare('DELETE FROM breeding_plans WHERE id=?').run(id)
      this.log('plan_deleted', 'plan', String(id), { name: saved.name })
    })
  }

  completeStep(input: CompleteStepInput): SavedPlan {
    const saved = this.plan(input.planId); const tree = saved.tree
    const step = tree.steps.find((entry) => entry.id === input.stepId)
    if (!step) throw new Error(`Step ${input.stepId} not found`)
    if (step.status === 'Completed') throw new Error('Step is already completed')
    const nodes = new Map(tree.nodes.map((node) => [node.id, node]))
    const parentA = nodes.get(step.parentAId); const parentB = nodes.get(step.parentBId); const resultNode = nodes.get(step.resultNodeId)
    if (!parentA || !parentB || !resultNode) throw new Error('Plan step references missing nodes')
    for (const parent of [parentA, parentB]) {
      if (parent.kind === 'missing') throw new Error(`Replace ${parent.missing?.id ?? parent.id} before completing this step`)
      if ((parent.kind === 'intermediate' || parent.kind === 'result') && !parent.producedInventoryId) throw new Error(`Dependency ${parent.id} has not been completed`)
    }
    const parentIds = [parentA.inventoryId ?? parentA.producedInventoryId, parentB.inventoryId ?? parentB.producedInventoryId]
    if (!parentIds[0] || !parentIds[1] || parentIds[0] === parentIds[1]) throw new Error('Step does not resolve to two distinct real parents')
    const observedIvs = {} as Record<Stat, number>
    for (const stat of STATS) {
      const guaranteed = resultNode.guaranteedIvs[stat]
      const observed = guaranteed ?? input.observedIvs?.[stat]
      if (observed === undefined || !resultNode.possibleIvs[stat].includes(observed)) throw new Error(`Observed ${stat} is required and must be one of: ${resultNode.possibleIvs[stat].join(', ')}`)
      observedIvs[stat] = observed
    }
    const observedNature = resultNode.natureGuaranteed ? resultNode.nature : input.observedNature
    if (!observedNature || !NATURES.includes(observedNature)) throw new Error('Observed nature is required for this intermediate')

    return this.database.transaction(() => {
      for (const id of parentIds as number[]) {
        const parent = this.inventoryById(id)
        if (!['Available', 'Reserved'].includes(parent.status)) throw new Error(`Parent #${id} is not available`)
        this.db.prepare('UPDATE missing_breeders SET replaced_inventory_id=NULL WHERE replaced_inventory_id=?').run(id)
        this.db.prepare('DELETE FROM pokemon_inventory WHERE id=?').run(id)
      }
      const isFinal = resultNode.id === tree.rootNodeId
      const created = this.createPokemon({
        speciesId: resultNode.speciesId as number, gender: resultNode.gender, ivs: observedIvs, nature: observedNature,
        alpha: resultNode.alpha, ha: resultNode.ha, boxId: null, notes: `Created by plan #${input.planId}, ${step.id}`,
        status: isFinal ? 'Available' : 'Reserved'
      }, 'breed_child_created')
      parentA.completed = true; parentB.completed = true; resultNode.completed = true; resultNode.producedInventoryId = created.id
      step.status = 'Completed'
      const complete = tree.steps.every((entry) => entry.status === 'Completed')
      const status = complete ? 'Completed' : 'In Progress'
      this.db.prepare('UPDATE breeding_plans SET status=?,plan_json=?,updated_at=? WHERE id=?').run(status, JSON.stringify(tree), now(), input.planId)
      this.db.prepare('UPDATE breeding_plan_steps SET status=?,data_json=? WHERE plan_id=? AND step_id=?').run('Completed', JSON.stringify(step), input.planId, step.id)
      this.db.prepare('UPDATE breeding_plan_nodes SET data_json=? WHERE plan_id=? AND node_id=?').run(JSON.stringify(resultNode), input.planId, resultNode.id)
      this.log('breeding_completed', 'plan_step', `${input.planId}:${step.id}`, { parents: parentIds, child: created.id })
      return this.plan(input.planId)
    })
  }

  replaceMissing(planId: number, missingId: string, pokemonId: number): SavedPlan {
    const saved = this.plan(planId); const tree = saved.tree
    const index = tree.nodes.findIndex((node) => node.missing?.id === missingId)
    if (index < 0) throw new Error(`Missing breeder ${missingId} not found`)
    const missing = tree.nodes[index] as PlanNode; const constraint = missing.missing as NonNullable<PlanNode['missing']>
    const pokemon = this.inventoryById(pokemonId)
    const failures: string[] = []
    const species = this.rules.species(pokemon.speciesId)
    if (pokemon.status !== 'Available') failures.push('Pokémon is not Available')
    if (!pokemon.breedingEnabled) failures.push('Pokémon is marked Unavailable for breeding')
    if (pokemon.gender !== constraint.gender) failures.push(`Gender must be ${constraint.gender}`)
    if (pokemon.alpha !== constraint.alpha) failures.push(`Alpha must be ${constraint.alpha ? 'Yes' : 'No'}`)
    if (constraint.ha !== null && pokemon.ha !== constraint.ha) failures.push(`HA must be ${constraint.ha ? 'Yes' : 'No'}`)
    if (constraint.nature && pokemon.nature !== constraint.nature) failures.push(`Nature must be ${constraint.nature}`)
    const lineageOrGroupMatches = constraint.eggGroups.includes('ditto') ? species.isDitto
      : constraint.evolutionChainId ? species.evolutionChainId === constraint.evolutionChainId
        : species.eggGroups.some((group) => constraint.eggGroups.includes(group))
    if (!lineageOrGroupMatches) failures.push('Evolution line/Egg Group constraint is not satisfied')
    for (const [stat, value] of Object.entries(constraint.requiredIvs)) if (pokemon.ivs[stat as Stat] !== value) failures.push(`${stat} must be ${value}`)
    for (const [stat, value] of Object.entries(constraint.minimumIvs ?? {})) if (pokemon.ivs[stat as Stat] < value) failures.push(`${stat} must be ${value} or higher`)
    if (failures.length) throw new Error(failures.join('; '))

    const replacement: PlanNode = {
      id: missing.id, kind: 'inventory', speciesId: pokemon.speciesId, inventoryId: pokemon.id, gender: pokemon.gender,
      guaranteedIvs: { ...pokemon.ivs }, possibleIvs: Object.fromEntries(STATS.map((stat) => [stat, [pokemon.ivs[stat]]])) as PlanNode['possibleIvs'],
      nature: pokemon.nature, natureGuaranteed: true, alpha: pokemon.alpha, ha: pokemon.ha, boxName: pokemon.boxName,
      provenanceInventoryIds: [pokemon.id], provenanceMissingIds: []
    }
    tree.nodes[index] = replacement
    this.resimulateTree(tree)
    const validation = this.validator.validate(tree)
    if (!validation.valid) throw new Error(`Replacement invalidates plan: ${validation.errors.join('; ')}`)
    tree.inventoryIds = [...new Set([...tree.inventoryIds, pokemon.id])].sort((a, b) => a - b)
    tree.missingBreeders = tree.nodes.flatMap((node) => node.missing ? [node.missing] : [])
    return this.database.transaction(() => {
      this.db.prepare("UPDATE pokemon_inventory SET status='Reserved',updated_at=? WHERE id=?").run(now(), pokemon.id)
      this.db.prepare('DELETE FROM missing_breeders WHERE plan_id=? AND missing_id=?').run(planId, missingId)
      this.persistPlanChildren(planId, tree, true)
      this.db.prepare('UPDATE breeding_plans SET plan_json=?,updated_at=? WHERE id=?').run(JSON.stringify(tree), now(), planId)
      this.log('missing_replaced', 'plan', String(planId), { missingId, pokemonId })
      return this.plan(planId)
    })
  }

  dashboard(): DashboardStats {
    const inventory = this.inventory({ status: 'Available', breedingEnabled: true })
    const ivBuckets: Record<string, number> = {}
    const eggCounts = new Map<string, number>()
    for (const pokemon of inventory) {
      const perfect = STATS.filter((stat) => pokemon.ivs[stat] === 31).length
      ivBuckets[`${perfect}x31`] = (ivBuckets[`${perfect}x31`] ?? 0) + 1
      for (const group of this.rules.species(pokemon.speciesId).eggGroups) eggCounts.set(group, (eggCounts.get(group) ?? 0) + 1)
    }
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM breeding_plans WHERE status IN ('Ready','In Progress')").get() as { count: number }
    return {
      available: inventory.length, alpha: inventory.filter((pokemon) => pokemon.alpha).length, ha: inventory.filter((pokemon) => pokemon.ha).length,
      boxes: this.boxes().length, activePlans: Number(active.count), ivBuckets,
      eggGroups: [...eggCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
    }
  }

  history(): unknown[] { return this.db.prepare('SELECT * FROM operation_history ORDER BY id DESC LIMIT 500').all() }

  settings(): Record<string, unknown> {
    return Object.fromEntries((this.db.prepare('SELECT key,value_json FROM app_settings').all() as unknown as Array<{ key: string; value_json: string }>).map((row) => [row.key, parse(row.value_json)]))
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(key, JSON.stringify(value), now())
  }

  clearSettingsPrefix(prefix: string): void {
    this.db.prepare("DELETE FROM app_settings WHERE key LIKE ? ESCAPE '\\'").run(`${prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)
  }

  exportData(): JsonExport {
    return { schemaVersion: APP_SCHEMA_VERSION, exportedAt: now(), boxes: this.boxes(), pokemon: this.inventory(), plans: this.plans().map((entry) => this.plan(entry.id)), settings: this.settings() }
  }

  importData(data: JsonExport): void {
    if (![1, 2, APP_SCHEMA_VERSION].includes(data.schemaVersion)) throw new Error(`Unsupported JSON schema version ${data.schemaVersion}`)
    if (!Array.isArray(data.boxes) || !Array.isArray(data.pokemon) || !Array.isArray(data.plans) || !data.settings || typeof data.settings !== 'object') throw new Error('JSON export has an invalid top-level structure')
    const pokemonToImport = data.pokemon.filter((pokemon) => pokemon.status !== 'Consumed')
    const boxIds = new Set<number>(); const pokemonIds = new Set<number>(); const planIds = new Set<number>()
    for (const box of data.boxes) {
      if (!Number.isInteger(box.id) || box.id <= 0 || boxIds.has(box.id) || !box.name?.trim()) throw new Error(`Invalid or duplicate box #${box.id}`)
      boxIds.add(box.id)
    }
    for (const pokemon of pokemonToImport) {
      if (!Number.isInteger(pokemon.id) || pokemon.id <= 0 || pokemonIds.has(pokemon.id)) throw new Error(`Invalid or duplicate Pokémon #${pokemon.id}`)
      pokemonIds.add(pokemon.id)
      const species = this.rules.species(pokemon.speciesId)
      if (!this.rules.validateGender(species.id, pokemon.gender)) throw new Error(`Invalid species/gender for Pokémon #${pokemon.id}`)
      if (pokemon.boxId !== null && !boxIds.has(pokemon.boxId)) throw new Error(`Pokémon #${pokemon.id} references missing box #${pokemon.boxId}`)
      if (!NATURES.includes(pokemon.nature) || !STATS.every((stat) => Number.isInteger(pokemon.ivs[stat]) && pokemon.ivs[stat] >= 0 && pokemon.ivs[stat] <= 31)) throw new Error(`Invalid nature or IVs for Pokémon #${pokemon.id}`)
    }
    for (const plan of data.plans) {
      if (!Number.isInteger(plan.id) || plan.id <= 0 || planIds.has(plan.id)) throw new Error(`Invalid or duplicate plan #${plan.id}`)
      planIds.add(plan.id)
      const validation = this.validator.validate(plan.tree)
      if (!validation.valid) throw new Error(`Imported plan #${plan.id} is invalid: ${validation.errors.join('; ')}`)
      const nodes = new Map(plan.tree.nodes.map((node) => [node.id, node]))
      for (const step of plan.tree.steps.filter((entry) => entry.status === 'Pending')) {
        for (const parentId of [step.parentAId, step.parentBId]) {
          const parent = nodes.get(parentId)
          const inventoryId = parent?.inventoryId ?? parent?.producedInventoryId
          if (inventoryId && !pokemonIds.has(inventoryId)) throw new Error(`Imported plan #${plan.id} references missing active Pokémon #${inventoryId}`)
        }
      }
    }
    this.database.transaction(() => {
      this.db.exec('DELETE FROM operation_history; DELETE FROM missing_breeders; DELETE FROM breeding_plan_edges; DELETE FROM breeding_plan_steps; DELETE FROM breeding_plan_nodes; DELETE FROM breeding_plans; DELETE FROM pokemon_inventory; DELETE FROM boxes;')
      for (const box of data.boxes) this.db.prepare('INSERT INTO boxes(id,name,created_at) VALUES(?,?,?)').run(box.id, box.name, box.createdAt)
      for (const pokemon of pokemonToImport) this.db.prepare(`INSERT INTO pokemon_inventory(id,species_id,gender,hp,atk,def,sp_atk,sp_def,speed,nature,alpha,ha,box_id,notes,status,breeding_enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        pokemon.id, pokemon.speciesId, pokemon.gender, pokemon.ivs.hp, pokemon.ivs.atk, pokemon.ivs.def, pokemon.ivs.spAtk, pokemon.ivs.spDef, pokemon.ivs.speed,
        pokemon.nature, pokemon.alpha ? 1 : 0, pokemon.ha ? 1 : 0, pokemon.boxId, pokemon.notes, pokemon.status, pokemon.breedingEnabled === false ? 0 : 1, pokemon.createdAt, pokemon.updatedAt)
      for (const plan of data.plans) {
        this.db.prepare(`INSERT INTO breeding_plans(id,name,status,target_json,plan_json,diagnostics_json,ruleset_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
          plan.id, plan.name, plan.status, JSON.stringify(plan.target), JSON.stringify(plan.tree), JSON.stringify(plan.diagnostics), plan.tree.rulesetVersion, plan.createdAt, plan.updatedAt)
        this.persistPlanChildren(plan.id, plan.tree)
      }
      for (const [key, value] of Object.entries(data.settings)) this.setSetting(key, value)
      this.log('json_import', 'database', null, { pokemon: pokemonToImport.length, plans: data.plans.length })
    })
  }

  private resimulateTree(tree: BreedingPlanTree): void {
    const nodes = new Map(tree.nodes.map((node) => [node.id, node]))
    for (const step of [...tree.steps].sort((a, b) => a.order - b.order)) {
      const a = nodes.get(step.parentAId); const b = nodes.get(step.parentBId); const result = nodes.get(step.resultNodeId)
      if (!a || !b || !result) throw new Error(`Broken step ${step.id}`)
      const simulated = this.simulator.simulate(a, b, step.parentAItem, step.parentBItem, step.selectedGender, result.speciesId)
      if (!simulated.valid || !simulated.result) throw new Error(simulated.errors.join('; '))
      Object.assign(result, simulated.result, {
        provenanceInventoryIds: [...new Set([...a.provenanceInventoryIds, ...b.provenanceInventoryIds])].sort((x, y) => x - y),
        provenanceMissingIds: [...new Set([...a.provenanceMissingIds, ...b.provenanceMissingIds])].sort(),
      })
      step.reasons = simulated.reasons
    }
  }

  private persistPlanChildren(planId: number, tree: BreedingPlanTree, replace = false): void {
    if (replace) this.db.prepare('DELETE FROM breeding_plan_nodes WHERE plan_id=?').run(planId)
    if (replace) this.db.prepare('DELETE FROM breeding_plan_steps WHERE plan_id=?').run(planId)
    if (replace) this.db.prepare('DELETE FROM breeding_plan_edges WHERE plan_id=?').run(planId)
    if (replace) this.db.prepare('DELETE FROM missing_breeders WHERE plan_id=?').run(planId)
    for (const node of tree.nodes) this.db.prepare('INSERT INTO breeding_plan_nodes(plan_id,node_id,kind,data_json) VALUES(?,?,?,?)').run(planId, node.id, node.kind, JSON.stringify(node))
    for (const step of tree.steps) {
      this.db.prepare('INSERT INTO breeding_plan_steps(plan_id,step_id,step_order,status,data_json) VALUES(?,?,?,?,?)').run(planId, step.id, step.order, step.status, JSON.stringify(step))
      this.db.prepare('INSERT INTO breeding_plan_edges(plan_id,source_node_id,target_node_id) VALUES(?,?,?)').run(planId, step.parentAId, step.resultNodeId)
      this.db.prepare('INSERT INTO breeding_plan_edges(plan_id,source_node_id,target_node_id) VALUES(?,?,?)').run(planId, step.parentBId, step.resultNodeId)
    }
    for (const missing of tree.missingBreeders) this.db.prepare('INSERT INTO missing_breeders(plan_id,missing_id,constraint_json) VALUES(?,?,?)').run(planId, missing.id, JSON.stringify(missing))
  }

  private log(action: string, entityType: string, entityId: string | null, data: unknown): void {
    this.db.prepare('INSERT INTO operation_history(action,entity_type,entity_id,data_json,created_at) VALUES(?,?,?,?,?)').run(action, entityType, entityId, JSON.stringify(data), now())
    this.onPersistentChange()
  }
}
