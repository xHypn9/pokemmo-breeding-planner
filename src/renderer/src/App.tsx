import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { NATURES, PLANNER_MAX_STATES, STATS } from '../../shared/constants'
import type {
  AlphaRequirement, BreedingPlanTree, BreedingTarget, BoxRecord, DashboardStats, Gender, InventoryInput,
  InventoryPokemon, Nature, PlanNode, PlannerProgress, SavedPlan, SavedPlanSummary, Species, Stat
} from '../../shared/types'
import { nodeMeetsTargetIv, normalizeTargetIvText, parseTargetIvText, targetIvIsExact, targetIvLabel } from '../../shared/target'
import { Sprite } from './components/Sprite'
import { PlanTree } from './components/PlanTree'
import { ScannerView } from './components/ScannerView'

type View = 'dashboard' | 'inventory' | 'quick' | 'scanner' | 'planner' | 'plans' | 'backup' | 'settings'
const labels: Record<View, string> = { dashboard: 'Dashboard', inventory: 'My Pokémon', quick: 'Quick Insert', scanner: 'Box Scanner', planner: 'Planner', plans: 'Saved Plans', backup: 'Backup / Restore', settings: 'Settings' }
const exactDefault = { hp: 31, atk: 31, def: 31, spAtk: 15, spDef: 31, speed: 31 }
const exactModeDefault = { hp: true, atk: true, def: true, spAtk: false, spDef: true, speed: true }
const defaultPlannerTarget = (): BreedingTarget => ({ speciesId: 445, ivs: { ...exactDefault }, ivExact: { ...exactModeDefault }, nature: 'Jolly', ha: 'Yes', alpha: 'Alpha', optimizer: 'balanced' })
const ivDraftsForTarget = (target: BreedingTarget): Record<Stat, string> => Object.fromEntries(STATS.map((stat) => [stat, target.ivs[stat] === null ? '' : targetIvLabel(target, stat)])) as Record<Stat, string>
const inventoryDisplayStatus = (pokemon: InventoryPokemon): InventoryPokemon['status'] | 'Unavailable' => pokemon.status === 'Available' && !pokemon.breedingEnabled ? 'Unavailable' : pokemon.status
const formatElapsed = (milliseconds: number): string => {
  const totalSeconds = Math.floor(milliseconds / 1_000)
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`
}

function useAsyncData() {
  const [species, setSpecies] = useState<Species[]>([]); const [boxes, setBoxes] = useState<BoxRecord[]>([])
  const [inventory, setInventory] = useState<InventoryPokemon[]>([]); const [plans, setPlans] = useState<SavedPlanSummary[]>([])
  const refresh = async () => {
    const [nextSpecies, nextBoxes, nextInventory, nextPlans] = await Promise.all([
      window.desktopApi.species.list(), window.desktopApi.boxes.list(), window.desktopApi.inventory.list(), window.desktopApi.plans.list()
    ])
    setSpecies(nextSpecies); setBoxes(nextBoxes); setInventory(nextInventory); setPlans(nextPlans)
  }
  useEffect(() => { void refresh() }, [])
  return { species, boxes, inventory, plans, refresh }
}

export function App() {
  const [view, setView] = useState<View>('dashboard'); const [notice, setNotice] = useState<string>('')
  const [visited, setVisited] = useState<Set<View>>(() => new Set(['dashboard']))
  const [openedPlan, setOpenedPlan] = useState<SavedPlan | null>(null)
  const [plannerTarget, setPlannerTarget] = useState<BreedingTarget | null>(null)
  const data = useAsyncData()
  const navigate = (next: View) => { setVisited((current) => current.has(next) ? current : new Set([...current, next])); setView(next) }
  const run = async (operation: () => Promise<unknown>, success: string) => {
    try { await operation(); setNotice(success); await data.refresh() } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const openSaved = async (id: number) => { try { setOpenedPlan(await window.desktopApi.plans.get(id)); navigate('plans') } catch (error) { setNotice(String(error)) } }

  return <div className="app-shell">
    <aside><div className="brand"><span className="brand-mark">α</span><div><strong>Breeding Planner</strong></div></div>
      <nav>{(Object.keys(labels) as View[]).map((key) => <button key={key} className={view === key ? 'active' : ''} onClick={() => navigate(key)}>{labels[key]}</button>)}</nav>
      <div className="sidebar-foot"><small>{data.inventory.filter((p) => p.status === 'Available' && p.breedingEnabled).length} available</small><small>{data.plans.filter((p) => ['Ready', 'In Progress'].includes(p.status)).length} active plans</small></div>
    </aside>
    <main><header><h1>{labels[view]}</h1>{notice && <button className="notice" onClick={() => setNotice('')}>{notice} ×</button>}</header>
      {visited.has('dashboard') && <div className="view-pane" hidden={view !== 'dashboard'}><Dashboard active={view === 'dashboard'} onNavigate={navigate} /></div>}
      {visited.has('inventory') && <div className="view-pane" hidden={view !== 'inventory'}><InventoryView {...data} run={run} /></div>}
      {visited.has('quick') && <div className="view-pane" hidden={view !== 'quick'}><QuickInsert {...data} run={run} /></div>}
      {visited.has('scanner') && <div className="view-pane" hidden={view !== 'scanner'}><ScannerView active={view === 'scanner'} species={data.species} boxes={data.boxes} refresh={data.refresh} setNotice={setNotice} /></div>}
      {visited.has('planner') && <div className="view-pane" hidden={view !== 'planner'}><PlannerView {...data} run={run} onOpenSaved={openSaved} initialTarget={plannerTarget} /></div>}
      {visited.has('plans') && <div className="view-pane" hidden={view !== 'plans'}><PlansView plans={data.plans} species={data.species} opened={openedPlan} setOpened={setOpenedPlan} refresh={data.refresh} setNotice={setNotice} onRecalculate={(target) => { setPlannerTarget(structuredClone(target)); navigate('planner') }} /></div>}
      {visited.has('backup') && <div className="view-pane" hidden={view !== 'backup'}><BackupView run={run} /></div>}
      {visited.has('settings') && <div className="view-pane" hidden={view !== 'settings'}><SettingsView run={run} /></div>}
    </main>
  </div>
}

function Dashboard({ active, onNavigate }: { active: boolean; onNavigate(view: View): void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  useEffect(() => { if (active) void window.desktopApi.dashboard.stats().then(setStats) }, [active])
  if (!stats) return <div className="loading">Loading local database…</div>
  return <section><div className="metric-grid">
    {[['Available', stats.available], ['Alpha', stats.alpha], ['HA potential', stats.ha], ['Boxes', stats.boxes], ['Active plans', stats.activePlans]].map(([label, value]) => <div className="metric" key={label}><strong>{value}</strong><span>{label}</span></div>)}
  </div><div className="dashboard-grid"><div className="panel"><div className="panel-title"><h2>IV distribution</h2></div><div className="bar-list">{Object.entries(stats.ivBuckets).sort().map(([name, count]) => <div key={name}><span>{name}</span><i style={{ width: `${Math.max(4, count / Math.max(1, stats.available) * 100)}%` }} /><b>{count}</b></div>)}</div></div>
    <div className="panel"><div className="panel-title"><h2>Egg Groups</h2></div><div className="tag-cloud">{stats.eggGroups.slice(0, 14).map((group) => <span key={group.name}>{group.name} <b>{group.count}</b></span>)}</div></div></div>
    <div className="actions-row"><button className="primary" onClick={() => onNavigate('quick')}>Quick Insert</button><button onClick={() => onNavigate('planner')}>Create target</button></div>
  </section>
}

function InventoryView({ species, boxes, inventory, refresh, run }: ReturnType<typeof useAsyncData> & { run(operation: () => Promise<unknown>, success: string): Promise<void> }) {
  const [query, setQuery] = useState(''); const [box, setBox] = useState(''); const [group, setGroup] = useState(''); const [gender, setGender] = useState('')
  const [alpha, setAlpha] = useState(''); const [ha, setHa] = useState(''); const [nature, setNature] = useState(''); const [status, setStatus] = useState(''); const [iv31, setIv31] = useState<Stat[]>([])
  const [editing, setEditing] = useState<InventoryPokemon | 'new' | null>(null); const [selected, setSelected] = useState<number[]>([]); const [addingBox, setAddingBox] = useState(false)
  const [sort, setSort] = useState<{ key: 'species' | 'gender' | Stat | 'nature' | 'traits' | 'box' | 'status'; direction: 1 | -1 }>({ key: 'species', direction: 1 })
  const speciesMap = useMemo(() => new Map(species.map((entry) => [entry.id, entry])), [species])
  const filtered = inventory.filter((pokemon) => {
    const meta = speciesMap.get(pokemon.speciesId); const q = query.toLowerCase()
    return (!q || meta?.name.toLowerCase().includes(q) || pokemon.notes.toLowerCase().includes(q)) && (!box || pokemon.boxId === Number(box))
      && (!group || meta?.eggGroups.includes(group)) && (!gender || pokemon.gender === gender) && (!alpha || pokemon.alpha === (alpha === 'yes'))
      && (!ha || pokemon.ha === (ha === 'yes')) && (!nature || pokemon.nature === nature) && (!status || inventoryDisplayStatus(pokemon) === status) && iv31.every((stat) => pokemon.ivs[stat] === 31)
  }).sort((a, b) => {
    const value = (pokemon: InventoryPokemon): string | number => {
      if (sort.key === 'species') return speciesMap.get(pokemon.speciesId)?.name ?? ''
      if (STATS.includes(sort.key as Stat)) return pokemon.ivs[sort.key as Stat]
      if (sort.key === 'gender') return pokemon.gender
      if (sort.key === 'nature') return pokemon.nature
      if (sort.key === 'traits') return Number(pokemon.alpha) * 2 + Number(pokemon.ha)
      if (sort.key === 'box') return pokemon.boxName ?? ''
      return inventoryDisplayStatus(pokemon)
    }
    const left = value(a); const right = value(b)
    const compared = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right))
    return compared === 0 ? a.id - b.id : compared * sort.direction
  })
  const eggGroups = [...new Set(species.flatMap((entry) => entry.eggGroups))].sort()
  const bulkUpdate = async (patch: Partial<InventoryInput>, label: string) => { if (selected.length) await run(() => window.desktopApi.inventory.bulkUpdate(selected, patch), `${selected.length} Pokémon: ${label}`) }
  const setSortKey = (key: typeof sort.key) => setSort((current) => ({ key, direction: current.key === key && current.direction === 1 ? -1 : 1 }))
  const sortHeader = (key: typeof sort.key, label: string) => <button className="sort-button" onClick={() => setSortKey(key)}>{label}{sort.key === key ? (sort.direction === 1 ? ' ↑' : ' ↓') : ''}</button>
  return <section><div className="toolbar filters"><input placeholder="Search species or notes" value={query} onChange={(e) => setQuery(e.target.value)} />
    <select value={box} onChange={(e) => setBox(e.target.value)}><option value="">All boxes</option>{boxes.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
    <select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">All Egg Groups</option>{eggGroups.map((entry) => <option key={entry}>{entry}</option>)}</select>
    <select value={gender} onChange={(e) => setGender(e.target.value)}><option value="">All genders</option><option>Male</option><option>Female</option><option>Genderless</option></select>
    <select value={alpha} onChange={(e) => setAlpha(e.target.value)}><option value="">Alpha: Any</option><option value="yes">Alpha: Yes</option><option value="no">Alpha: No</option></select>
    <select value={ha} onChange={(e) => setHa(e.target.value)}><option value="">HA: Any</option><option value="yes">HA: Yes</option><option value="no">HA: No</option></select>
    <select value={nature} onChange={(e) => setNature(e.target.value)}><option value="">All natures</option>{NATURES.map((entry) => <option key={entry}>{entry}</option>)}</select>
    <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option>Available</option><option>Unavailable</option><option>Reserved</option><option>Consumed</option></select>
  </div><div className="toolbar compact"><span>31 IV:</span>{STATS.map((stat) => <label className="check" key={stat}><input type="checkbox" checked={iv31.includes(stat)} onChange={() => setIv31((old) => old.includes(stat) ? old.filter((x) => x !== stat) : [...old, stat])} />{stat}</label>)}
    <span className="spacer" /><button onClick={() => setAddingBox(true)}>+ Box</button><button className="primary" onClick={() => setEditing('new')}>+ Pokémon</button></div>
  {selected.length > 0 && <div className="bulk-bar"><b>{selected.length} selected</b><select onChange={(e) => { if (e.target.value) void bulkUpdate({ boxId: Number(e.target.value) }, 'box updated') }} defaultValue=""><option value="">Move to box…</option>{boxes.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select><select onChange={(e) => { if (e.target.value) void bulkUpdate({ nature: e.target.value as Nature }, `nature ${e.target.value}`) }} defaultValue=""><option value="">Set nature…</option>{NATURES.map((entry) => <option key={entry}>{entry}</option>)}</select><select onChange={(e) => { if (e.target.value) void bulkUpdate({ alpha: e.target.value === 'yes' }, `Alpha ${e.target.value}`) }} defaultValue=""><option value="">Set Alpha…</option><option value="yes">Yes</option><option value="no">No</option></select><select onChange={(e) => { if (e.target.value) void bulkUpdate({ ha: e.target.value === 'yes' }, `HA ${e.target.value}`) }} defaultValue=""><option value="">Set HA…</option><option value="yes">Yes</option><option value="no">No</option></select><select onChange={(e) => { if (e.target.value) void bulkUpdate({ breedingEnabled: e.target.value === 'available' }, e.target.value) }} defaultValue=""><option value="">Set breeding status…</option><option value="available">Available</option><option value="unavailable">Unavailable</option></select><button onClick={() => setSelected([])}>Clear</button></div>}
  <div className="table-wrap"><table><thead><tr><th><input type="checkbox" onChange={(e) => setSelected(e.target.checked ? filtered.map((p) => p.id) : [])} /></th><th>{sortHeader('species', 'Pokémon')}</th><th>{sortHeader('gender', 'Sex')}</th>{STATS.map((stat) => <th key={stat}>{sortHeader(stat, stat)}</th>)}<th>{sortHeader('nature', 'Nature')}</th><th>{sortHeader('traits', 'Traits')}</th><th>{sortHeader('box', 'Box')}</th><th>{sortHeader('status', 'Status')}</th><th /></tr></thead>
    <tbody>{filtered.map((pokemon) => { const displayStatus = inventoryDisplayStatus(pokemon); return <tr key={pokemon.id} className={displayStatus !== 'Available' ? 'muted' : ''}><td><input type="checkbox" checked={selected.includes(pokemon.id)} onChange={() => setSelected((old) => old.includes(pokemon.id) ? old.filter((id) => id !== pokemon.id) : [...old, pokemon.id])} /></td>
      <td className="pokemon-cell"><Sprite speciesId={pokemon.speciesId} size={34} /><div><b>{speciesMap.get(pokemon.speciesId)?.name}</b><small>#{pokemon.id}</small></div></td><td>{pokemon.gender}</td>
      {STATS.map((stat) => <td className={pokemon.ivs[stat] === 31 ? 'perfect' : ''} key={stat}>{pokemon.ivs[stat]}</td>)}<td>{pokemon.nature}</td><td>{pokemon.alpha && <span className="badge alpha">α</span>} {pokemon.ha && <span className="badge ha">HA</span>}</td><td>{pokemon.boxName ?? '—'}</td><td><span className={`status ${displayStatus.toLowerCase()}`}>{displayStatus}</span></td>
      <td><button className="icon" onClick={() => setEditing(pokemon)}>Edit</button> <button className="icon danger" onClick={() => confirm(`Delete #${pokemon.id}?`) && void run(() => window.desktopApi.inventory.delete(pokemon.id), `#${pokemon.id} deleted`)}>Delete</button></td></tr> })}</tbody></table></div>
  {editing && <PokemonModal value={editing === 'new' ? null : editing} species={species} boxes={boxes} onClose={() => setEditing(null)} onSave={async (input) => {
    await run(() => editing === 'new' ? window.desktopApi.inventory.create(input) : window.desktopApi.inventory.update(editing.id, input), editing === 'new' ? 'Pokémon added' : 'Pokémon updated'); setEditing(null); await refresh()
  }} />}
  {addingBox && <BoxModal onClose={() => setAddingBox(false)} onCreate={async (name) => { await run(() => window.desktopApi.boxes.create(name), `Box ${name} created`); setAddingBox(false) }} />}</section>
}

function BoxModal({ onClose, onCreate }: { onClose(): void; onCreate(name: string): Promise<void> }) {
  const [name, setName] = useState('')
  return <div className="modal-backdrop"><form className="modal box-modal" onSubmit={(event) => { event.preventDefault(); const clean = name.trim(); if (clean) void onCreate(clean) }}>
    <div className="panel-title"><h2>Create Box</h2><button type="button" onClick={onClose}>×</button></div>
    <label>Box name<input autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: Alpha 1" /></label>
    <div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim()}>Create Box</button></div>
  </form></div>
}

function PokemonModal({ value, species, boxes, onClose, onSave }: { value: InventoryPokemon | null; species: Species[]; boxes: BoxRecord[]; onClose(): void; onSave(input: InventoryInput): Promise<void> }) {
  const initialSpecies = value?.speciesId ?? 443
  const [form, setForm] = useState<InventoryInput>({ speciesId: initialSpecies, gender: value?.gender ?? 'Female', ivs: value?.ivs ?? { ...exactDefault }, nature: value?.nature ?? 'Jolly', alpha: value?.alpha ?? true, ha: value?.ha ?? false, boxId: value?.boxId ?? boxes[0]?.id ?? null, notes: value?.notes ?? '', breedingEnabled: value?.breedingEnabled ?? true })
  const meta = species.find((entry) => entry.id === form.speciesId)
  const genders: Gender[] = meta?.gender.kind === 'genderless' ? ['Genderless'] : meta?.gender.femaleEighths === 0 ? ['Male'] : meta?.gender.femaleEighths === 8 ? ['Female'] : ['Female', 'Male']
  return <div className="modal-backdrop"><form className="modal" onSubmit={(e) => { e.preventDefault(); void onSave(form) }}><div className="panel-title"><h2>{value ? `Edit #${value.id}` : 'Add Pokémon'}</h2><button type="button" onClick={onClose}>×</button></div>
    <label>Species<select value={form.speciesId} onChange={(e) => { const id = Number(e.target.value); const next = species.find((s) => s.id === id); const allowed: Gender = next?.gender.kind === 'genderless' ? 'Genderless' : next?.gender.femaleEighths === 0 ? 'Male' : next?.gender.femaleEighths === 8 ? 'Female' : 'Female'; setForm({ ...form, speciesId: id, gender: allowed }) }}>{species.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <div className="metadata"><span>Egg Groups: <b>{meta?.eggGroups.join(' + ')}</b></span><span>Hatches as: <b>{species.find((s) => s.id === meta?.hatchSpeciesId)?.name}</b></span></div>
    <div className="form-grid"><label>Gender<select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value as Gender })}>{genders.map((g) => <option key={g}>{g}</option>)}</select></label><label>Nature<select value={form.nature} onChange={(e) => setForm({ ...form, nature: e.target.value as Nature })}>{NATURES.map((n) => <option key={n}>{n}</option>)}</select></label><label>Box<select value={form.boxId ?? ''} onChange={(e) => setForm({ ...form, boxId: e.target.value ? Number(e.target.value) : null })}><option value="">No box</option>{boxes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label><label>Breeding status<select disabled={value?.status !== undefined && value.status !== 'Available'} value={form.breedingEnabled === false ? 'unavailable' : 'available'} onChange={(e) => setForm({ ...form, breedingEnabled: e.target.value === 'available' })}><option value="available">Available</option><option value="unavailable">Unavailable</option></select></label></div>
    <div className="ivs-editor">{STATS.map((stat) => <label key={stat}>{stat}<input type="number" min="0" max="31" value={form.ivs[stat]} onChange={(e) => setForm({ ...form, ivs: { ...form.ivs, [stat]: Number(e.target.value) } })} /></label>)}</div>
    <div className="form-grid"><label className="switch"><input type="checkbox" checked={form.alpha} onChange={(e) => setForm({ ...form, alpha: e.target.checked })} />Alpha</label><label className="switch"><input type="checkbox" checked={form.ha} onChange={(e) => setForm({ ...form, ha: e.target.checked })} />HA potential</label></div>
    <label>Notes<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label><div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Save</button></div></form></div>
}

type GridRow = { species: string; gender: Gender; hp: string; atk: string; def: string; spAtk: string; spDef: string; speed: string; nature: Nature; alpha: boolean; ha: boolean; boxId: number | null }
const blankRow = (alpha = true, boxId: number | null = null): GridRow => ({ species: '', gender: 'Female', hp: '', atk: '', def: '', spAtk: '', spDef: '', speed: '', nature: 'Jolly', alpha, ha: false, boxId })

function SpeciesAutocomplete({ value, species, onChange, onPaste }: { value: string; species: Species[]; onChange(value: string): void; onPaste(event: ReactClipboardEvent<HTMLInputElement>): void }) {
  const [open, setOpen] = useState(false); const [highlighted, setHighlighted] = useState(0)
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null); const menuRef = useRef<HTMLDivElement>(null)
  const matches = useMemo(() => {
    const query = value.trim().toLowerCase()
    return species.filter((entry) => !query || entry.name.toLowerCase().includes(query) || entry.slug.includes(query))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)) || a.id - b.id)
  }, [species, value])
  useEffect(() => { setHighlighted(0) }, [value])
  useEffect(() => { menuRef.current?.querySelector(`[data-option="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' }) }, [highlighted])
  const show = () => {
    const rect = inputRef.current?.getBoundingClientRect(); if (!rect) return
    const menuHeight = 270; const top = window.innerHeight - rect.bottom >= menuHeight ? rect.bottom + 3 : Math.max(8, rect.top - menuHeight - 3)
    setPosition({ left: rect.left, top, width: Math.max(rect.width, 210) }); setOpen(true)
  }
  const choose = (entry: Species) => { onChange(entry.name); setOpen(false) }
  return <div className="species-autocomplete"><input ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded={open} value={value} onFocus={show}
    onBlur={() => window.setTimeout(() => setOpen(false), 120)} onPaste={onPaste}
    onChange={(event) => { onChange(event.target.value); show() }}
    onKeyDown={(event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); show(); setHighlighted((index) => Math.min(matches.length - 1, index + 1)) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); show(); setHighlighted((index) => Math.max(0, index - 1)) }
      else if (event.key === 'Enter' && open && matches[highlighted]) { event.preventDefault(); choose(matches[highlighted]) }
      else if (event.key === 'Tab' && value.trim() && open && matches[highlighted] && value.toLowerCase() !== matches[highlighted].name.toLowerCase()) choose(matches[highlighted])
      else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    }} />
    {open && position && createPortal(<div ref={menuRef} className="species-autocomplete-menu" role="listbox" style={position}>
      {matches.length ? matches.map((entry, index) => <button type="button" role="option" aria-selected={index === highlighted} data-option={index} className={index === highlighted ? 'highlighted' : ''} key={entry.id}
        onMouseEnter={() => setHighlighted(index)} onMouseDown={(event) => { event.preventDefault(); choose(entry) }}><span>{entry.name}</span><small>#{entry.id}</small></button>) : <div className="no-options">No matching Pokémon</div>}
    </div>, document.body)}
  </div>
}

function QuickInsert({ species, boxes, run }: ReturnType<typeof useAsyncData> & { run(operation: () => Promise<unknown>, success: string): Promise<void> }) {
  const [defaultAlpha, setDefaultAlpha] = useState(true); const [currentBox, setCurrentBox] = useState<number | null>(boxes[0]?.id ?? null)
  const [rows, setRows] = useState<GridRow[]>(() => Array.from({ length: 20 }, () => blankRow(true, null)))
  const byName = useMemo(() => new Map(species.flatMap((entry) => [[entry.name.toLowerCase(), entry], [entry.slug.toLowerCase(), entry]])), [species])
  const update = (index: number, patch: Partial<GridRow>) => setRows((old) => old.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row))
  const errorFor = (row: GridRow): string | null => {
    if (!row.species.trim()) return null
    const meta = byName.get(row.species.trim().toLowerCase()); if (!meta) return 'Unknown species'
    const allowed = meta.gender.kind === 'genderless' ? ['Genderless'] : meta.gender.femaleEighths === 0 ? ['Male'] : meta.gender.femaleEighths === 8 ? ['Female'] : ['Female', 'Male']
    if (!allowed.includes(row.gender)) return `${meta.name} cannot be ${row.gender}`
    for (const stat of STATS) { const value = Number(row[stat]); if (row[stat] === '' || !Number.isInteger(value) || value < 0 || value > 31) return `${stat} must be 0–31` }
    return null
  }
  const paste = (startRow: number, startColumn: number, text: string) => {
    const columns: Array<keyof GridRow> = ['species', 'gender', 'hp', 'atk', 'def', 'spAtk', 'spDef', 'speed', 'nature', 'alpha', 'ha', 'boxId']
    const lines = text.replace(/\r/g, '').split('\n').filter(Boolean).map((line) => line.split('\t'))
    setRows((old) => {
      const next = [...old]; while (next.length < startRow + lines.length) next.push(blankRow(defaultAlpha, currentBox))
      lines.forEach((cells, y) => { const row = { ...(next[startRow + y] as GridRow) }; cells.forEach((cell, x) => {
        const key = columns[startColumn + x]; if (!key) return
        if (key === 'alpha' || key === 'ha') (row as Record<string, unknown>)[key] = /^(true|yes|1|si|sì)$/i.test(cell)
        else if (key === 'boxId') row.boxId = boxes.find((b) => b.name.toLowerCase() === cell.toLowerCase())?.id ?? (Number(cell) || currentBox)
        else (row as Record<string, unknown>)[key] = cell
      }); next[startRow + y] = row })
      return next
    })
  }
  const save = async () => {
    const populated = rows.filter((row) => row.species.trim()); const errors = populated.map(errorFor).filter(Boolean)
    if (errors.length) throw new Error(`${errors.length} invalid rows; first error: ${errors[0]}`)
    const inputs: InventoryInput[] = populated.map((row) => ({ speciesId: byName.get(row.species.trim().toLowerCase())!.id, gender: row.gender, ivs: Object.fromEntries(STATS.map((stat) => [stat, Number(row[stat])])) as InventoryInput['ivs'], nature: row.nature, alpha: row.alpha, ha: row.ha, boxId: row.boxId, notes: '' }))
    await run(() => window.desktopApi.inventory.bulkCreate(inputs), `${inputs.length} Pokémon imported`); setRows(Array.from({ length: 20 }, () => blankRow(defaultAlpha, currentBox)))
  }
  return <section><div className="toolbar"><label className="switch"><input type="checkbox" checked={defaultAlpha} onChange={(e) => setDefaultAlpha(e.target.checked)} />Default Alpha</label><label>Current box <select value={currentBox ?? ''} onChange={(e) => setCurrentBox(e.target.value ? Number(e.target.value) : null)}><option value="">No box</option>{boxes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label><button onClick={() => setRows((old) => [...old, blankRow(defaultAlpha, currentBox)])}>+ Row</button><span className="spacer" /><button className="primary" onClick={() => void save().catch((e) => alert(e.message))}>Save batch</button></div>
    <div className="table-wrap quick-grid"><table><thead><tr><th>#</th><th>Species</th><th>Gender</th>{STATS.map((s) => <th key={s}>{s}</th>)}<th>Nature</th><th>Alpha</th><th>HA</th><th>Box</th><th /></tr></thead>
      <tbody>{rows.map((row, index) => {
        const error = errorFor(row)
        return <tr key={index} className={error ? 'row-error' : ''} title={error ?? ''}>
          <td>{index + 1}</td>
          <td><SpeciesAutocomplete value={row.species} species={species}
            onPaste={(event) => { const text = event.clipboardData.getData('text'); if (text.includes('\t') || text.includes('\n')) { event.preventDefault(); paste(index, 0, text) } }}
            onChange={(value) => {
              const meta = byName.get(value.toLowerCase())
              let nextGender = row.gender
              if (meta?.gender.kind === 'genderless') nextGender = 'Genderless'
              else if (meta?.gender.kind === 'ratio' && meta.gender.femaleEighths === 0) nextGender = 'Male'
              else if (meta?.gender.kind === 'ratio' && meta.gender.femaleEighths === 8) nextGender = 'Female'
              update(index, { species: value, gender: nextGender, alpha: row.species ? row.alpha : defaultAlpha, boxId: row.species ? row.boxId : currentBox })
            }} /></td>
          <td><select value={row.gender} onChange={(event) => update(index, { gender: event.target.value as Gender })}><option>Female</option><option>Male</option><option>Genderless</option></select></td>
          {STATS.map((stat, column) => <td key={stat}><input type="number" min="0" max="31" value={row[stat]}
            onPaste={(event) => { const text = event.clipboardData.getData('text'); if (text.includes('\t') || text.includes('\n')) { event.preventDefault(); paste(index, column + 2, text) } }}
            onChange={(event) => update(index, { [stat]: event.target.value })} /></td>)}
          <td><select value={row.nature} onChange={(event) => update(index, { nature: event.target.value as Nature })}>{NATURES.map((nature) => <option key={nature}>{nature}</option>)}</select></td>
          <td><input type="checkbox" checked={row.alpha} onChange={(event) => update(index, { alpha: event.target.checked })} /></td>
          <td><input type="checkbox" checked={row.ha} onChange={(event) => update(index, { ha: event.target.checked })} /></td>
          <td><select value={row.boxId ?? ''} onChange={(event) => update(index, { boxId: event.target.value ? Number(event.target.value) : null })}><option value="">—</option>{boxes.map((box) => <option key={box.id} value={box.id}>{box.name}</option>)}</select></td>
          <td><button className="icon" onClick={() => setRows((old) => [...old.slice(0, index + 1), { ...row }, ...old.slice(index + 1)])}>Copy</button> <button className="icon danger" onClick={() => setRows((old) => old.filter((_, rowIndex) => rowIndex !== index))}>×</button></td>
        </tr>
      })}</tbody>
    </table></div></section>
}

function PlannerView({ species, inventory, run, onOpenSaved, initialTarget }: ReturnType<typeof useAsyncData> & { run(operation: () => Promise<unknown>, success: string): Promise<void>; onOpenSaved(id: number): Promise<void>; initialTarget: BreedingTarget | null }) {
  const [target, setTarget] = useState<BreedingTarget>(() => initialTarget ? structuredClone(initialTarget) : defaultPlannerTarget())
  const [ivDrafts, setIvDrafts] = useState<Record<Stat, string>>(() => ivDraftsForTarget(initialTarget ?? defaultPlannerTarget()))
  const [plan, setPlan] = useState<BreedingPlanTree | null>(null); const [progress, setProgress] = useState(''); const [selectedNode, setSelectedNode] = useState<PlanNode | null>(null)
  const [running, setRunning] = useState(false); const [workerProgress, setWorkerProgress] = useState<PlannerProgress | null>(null); const [elapsedMs, setElapsedMs] = useState(0)
  const worker = useRef<Worker | null>(null); const meta = species.find((entry) => entry.id === target.speciesId)
  const workerStartedAt = useRef(0)
  useEffect(() => { if (initialTarget) { worker.current?.terminate(); worker.current = null; setRunning(false); setWorkerProgress(null); const loaded = structuredClone(initialTarget); setTarget(loaded); setIvDrafts(ivDraftsForTarget(loaded)); setPlan(null); setProgress('Target loaded from saved plan') } }, [initialTarget])
  useEffect(() => () => { worker.current?.terminate(); worker.current = null }, [])
  useEffect(() => {
    if (!running) return
    const updateElapsed = () => setElapsedMs(performance.now() - workerStartedAt.current)
    updateElapsed(); const timer = window.setInterval(updateElapsed, 250)
    return () => window.clearInterval(timer)
  }, [running])
  const calculate = () => {
    if (worker.current || running) return
    const invalidStat = STATS.find((stat) => !parseTargetIvText(ivDrafts[stat]).valid)
    if (invalidStat) { setProgress(`${invalidStat}: use a blank value, 0–31, or a minimum such as 25+`); return }
    setPlan(null); setSelectedNode(null); setProgress('Starting isolated planner worker…'); setWorkerProgress(null); setElapsedMs(0); workerStartedAt.current = performance.now(); setRunning(true)
    let next: Worker
    try { next = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' }); worker.current = next }
    catch (error) { setRunning(false); setProgress(`Could not start planner worker: ${error instanceof Error ? error.message : String(error)}`); return }
    next.onmessage = (event) => {
      if (worker.current !== next) return
      if (event.data.type === 'progress') { setWorkerProgress(event.data.progress); setProgress(`${event.data.progress.phase} · ${event.data.progress.explored} states`) }
      if (event.data.type === 'result') { const elapsed = performance.now() - workerStartedAt.current; setElapsedMs(elapsed); setPlan(event.data.plan); setProgress(`Validated plan ready in ${formatElapsed(elapsed)}`); setRunning(false); next.terminate(); worker.current = null }
      if (event.data.type === 'error') { const elapsed = performance.now() - workerStartedAt.current; setElapsedMs(elapsed); setProgress(`${event.data.message} · ${formatElapsed(elapsed)}`); setRunning(false); next.terminate(); worker.current = null }
    }
    next.onerror = (event) => {
      if (worker.current !== next) return
      const elapsed = performance.now() - workerStartedAt.current; setElapsedMs(elapsed); setProgress(`Planner worker failed: ${event.message} · ${formatElapsed(elapsed)}`); setRunning(false); next.terminate(); worker.current = null
    }
    next.postMessage({ inventory: inventory.filter((entry) => entry.status === 'Available' && entry.breedingEnabled), target })
  }
  const cancel = () => {
    if (!worker.current) return
    worker.current.terminate(); worker.current = null
    const elapsed = performance.now() - workerStartedAt.current; setElapsedMs(elapsed); setRunning(false); setWorkerProgress(null); setProgress(`Cancelled after ${formatElapsed(elapsed)}`)
  }
  const save = async () => { if (!plan) return; const name = prompt('Plan name', `${meta?.name} ${target.nature}`); if (!name) return; let savedId = 0; await run(async () => { const saved = await window.desktopApi.plans.save(name, plan); savedId = saved.id }, 'Plan saved and inventory reserved'); if (savedId) await onOpenSaved(savedId) }
  return <section><div className="planner-layout"><div className="panel target-panel"><div className="panel-title"><h2>New target</h2><span className="badge verified">GUARANTEED ONLY</span></div>
    <label>Pokémon<select value={target.speciesId} onChange={(e) => setTarget({ ...target, speciesId: Number(e.target.value) })}>{species.filter((entry) => entry.breedable).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
    <div className="metadata"><span>Egg Groups <b>{meta?.eggGroups.join(' + ')}</b></span><span>Offspring <b>{species.find((s) => s.id === meta?.hatchSpeciesId)?.name}</b></span></div>
    <div className="ivs-editor target-ivs">{STATS.map((stat) => {
      const parsed = parseTargetIvText(ivDrafts[stat]); const ignored = parsed.valid && parsed.value === null; const exact = targetIvIsExact(target, stat)
      return <div className="target-iv-control" key={stat}><span>{stat}</span><input
        aria-label={`${stat} target IV`} inputMode="text" value={ivDrafts[stat]} placeholder="IGNORE"
        className={!parsed.valid ? 'invalid-target-iv' : ignored ? 'ignored-iv' : exact ? '' : 'minimum-iv'}
        onChange={(event) => {
          const raw = event.target.value; const next = parseTargetIvText(raw); setIvDrafts((current) => ({ ...current, [stat]: raw }))
          if (next.valid) setTarget((current) => ({ ...current, ivs: { ...current.ivs, [stat]: next.value }, ivExact: { ...current.ivExact, [stat]: next.exact } }))
        }}
        onBlur={() => setIvDrafts((current) => ({ ...current, [stat]: normalizeTargetIvText(current[stat], exact) }))}
      /><label className="exact-toggle"><input type="checkbox" disabled={ignored || !parsed.valid || target.ivs[stat] === 31} checked={!ignored && exact} onChange={(event) => {
        const value = target.ivs[stat]; if (value === null) return
        const nextExact = event.target.checked; setTarget((current) => ({ ...current, ivExact: { ...current.ivExact, [stat]: nextExact } })); setIvDrafts((current) => ({ ...current, [stat]: `${value}${nextExact ? '' : '+'}` }))
      }} />Exact</label><small>{!parsed.valid ? 'INVALID' : ignored ? 'IGNORE' : exact ? 'EXACT' : `MIN ${target.ivs[stat]}+`}</small></div>
    })}</div>
    <label>Nature<select value={target.nature} onChange={(e) => setTarget({ ...target, nature: e.target.value as Nature })}>{NATURES.map((n) => <option key={n}>{n}</option>)}</select></label>
    <div className="form-grid"><label>Hidden Ability<select value={target.ha} onChange={(e) => setTarget({ ...target, ha: e.target.value as BreedingTarget['ha'] })}><option>Any</option><option>Yes</option><option>No</option></select></label><label>Type<select value={target.alpha} onChange={(e) => setTarget({ ...target, alpha: e.target.value as AlphaRequirement })}><option>Any</option><option>Normal</option><option>Alpha</option></select></label></div>
    <label>Optimization<select value={target.optimizer} onChange={(e) => setTarget({ ...target, optimizer: e.target.value as BreedingTarget['optimizer'] })}><option value="missing">Minimum missing breeders</option><option value="breeds">Minimum breeds</option><option value="balanced">Balanced</option></select></label>
    <div className="modal-actions"><button disabled={!running} onClick={cancel}>Cancel</button><button className="primary" disabled={running} onClick={calculate}>{running ? 'Calculating…' : 'Calculate'}</button></div>{running ? <div className="planner-progress-card">
      <div className="planner-progress-meta"><span>{workerProgress?.phase ?? 'Starting worker'}</span><b>{(workerProgress?.explored ?? 0).toLocaleString()} / {PLANNER_MAX_STATES.toLocaleString()} states</b><time>{formatElapsed(elapsedMs)}</time></div>
      <div className="planner-progress-track" role="progressbar" aria-label="Planner search progress" aria-valuemin={0} aria-valuemax={PLANNER_MAX_STATES} aria-valuenow={workerProgress?.explored ?? 0}><span className={`planner-progress-fill ${workerProgress?.explored ? '' : 'indeterminate'}`} style={workerProgress?.explored ? { width: `${Math.min(100, workerProgress.explored / PLANNER_MAX_STATES * 100)}%` } : undefined} /></div>
    </div> : <small className="progress">{progress}</small>}</div>
    <div className="panel planner-result">{plan ? <><div className="panel-title"><div><h2>{plan.valid ? 'Validated breeding tree' : 'Invalid plan'}</h2><small>{plan.steps.length} breeds · {plan.inventoryIds.length} owned · {plan.missingBreeders.length} missing</small></div><button className="primary" onClick={() => void save()}>Save plan</button></div>
      <PlanTree plan={plan} species={species} onSelect={setSelectedNode} />
      <div className="diagnostics"><b>Planner diagnostics</b><span>Explored {plan.diagnostics.statesExplored}</span><span>Pruned {plan.diagnostics.statesPruned}</span><span>Cache hits {plan.diagnostics.cacheHits}</span><span>{plan.diagnostics.searchTimeMs} ms</span>{plan.diagnostics.failureReason && <span>{plan.diagnostics.failureReason}</span>}</div></> : <div className="empty-state"><span className="empty-icon">⌘</span><h2>{running ? 'Calculating breeding tree…' : 'Ready'}</h2>{running && <p>{(workerProgress?.explored ?? 0).toLocaleString()} / {PLANNER_MAX_STATES.toLocaleString()} · {formatElapsed(elapsedMs)}</p>}</div>}</div></div>
  {selectedNode && <NodeDetail node={selectedNode} species={species} plan={plan} onClose={() => setSelectedNode(null)} />}</section>
}

function NodeDetail({ node, species, plan, onClose }: { node: PlanNode; species: Species[]; plan: BreedingPlanTree | null; onClose(): void }) {
  const step = plan?.steps.find((entry) => entry.resultNodeId === node.id)
  return <div className="drawer"><div className="panel-title"><h2>{node.kind === 'missing' ? node.missing?.id.toUpperCase() : species.find((entry) => entry.id === node.speciesId)?.name}</h2><button onClick={onClose}>×</button></div>
    <div className="detail-head"><Sprite speciesId={node.speciesId} size={70} /><div><b>{node.gender}</b><span>{node.alpha ? 'Alpha' : 'Normal'} · {node.ha ? 'HA Yes' : 'HA No'}</span><span>{node.boxName ?? ''}</span></div></div>
    <div className="iv-detail">{STATS.map((stat) => {
      const target = plan?.target; const ignored = target?.ivs[stat] === null; const exact = target ? targetIvIsExact(target, stat) : true; const meets = target ? nodeMeetsTargetIv(node, target, stat) : false
      const wanted = target?.ivs[stat]; const range = node.possibleIvs[stat]; const display = ignored ? '—' : node.guaranteedIvs[stat] ?? (meets && !exact ? `≥${wanted}` : '?')
      const detail = ignored ? 'Ignored by target' : !exact && meets ? `Target ≥${wanted} · range ${range[0]}–${range.at(-1)}` : node.guaranteedIvs[stat] === null ? `Possible: ${range.join(', ')}` : exact ? 'Exact target guaranteed' : `Target ≥${wanted}`
      return <div className={ignored ? 'ignored-detail' : ''} key={stat}><span>{stat}</span><b>{display}</b><small>{detail}</small></div>
    })}</div>
    {node.missing && <div className="constraint"><h3>External constraints</h3><p>Egg Group: {node.missing.eggGroups.join(' + ')}</p><p>Gender: {node.missing.gender}</p><p>Nature: {node.missing.nature ?? 'Any'} · HA: {node.missing.ha === null ? 'Any' : node.missing.ha ? 'Required' : 'No'} · Alpha: {node.missing.alpha ? 'Yes' : 'No'}</p></div>}
    {step && <div className="constraint"><h3>Breed step #{step.order}</h3><p>Parent A: {step.parentAItem.type === 'Brace' ? `Brace → ${step.parentAItem.stat}` : step.parentAItem.type === 'Everstone' ? `Everstone → ${step.parentAItem.nature}` : 'No item'}</p><p>Parent B: {step.parentBItem.type === 'Brace' ? `Brace → ${step.parentBItem.stat}` : step.parentBItem.type === 'Everstone' ? `Everstone → ${step.parentBItem.nature}` : 'No item'}</p><p className="select-gender">SELECT {step.selectedGender.toUpperCase()}</p>{step.reasons.map((reason, i) => <small key={i}>{reason.property}: {reason.reason}</small>)}</div>}
  </div>
}

function PlansView({ plans, species, opened, setOpened, refresh, setNotice, onRecalculate }: { plans: SavedPlanSummary[]; species: Species[]; opened: SavedPlan | null; setOpened(plan: SavedPlan | null): void; refresh(): Promise<void>; setNotice(message: string): void; onRecalculate(target: BreedingTarget): void }) {
  const [selectedNode, setSelectedNode] = useState<PlanNode | null>(null)
  const load = async (id: number) => setOpened(await window.desktopApi.plans.get(id))
  const nextStep = opened?.tree.steps.find((step) => step.status === 'Pending' && [step.parentAId, step.parentBId].every((id) => {
    const node = opened.tree.nodes.find((entry) => entry.id === id); return node && node.kind !== 'missing' && (!['intermediate', 'result'].includes(node.kind) || node.producedInventoryId)
  }))
  const complete = async () => {
    if (!opened || !nextStep || !confirm(`Confirm ${nextStep.id}? Both parents will be consumed. A safety snapshot is created first.`)) return
    const result = opened.tree.nodes.find((node) => node.id === nextStep.resultNodeId); if (!result) return
    const observedIvs: Partial<Record<Stat, number>> = {}
    for (const stat of STATS) if (result.guaranteedIvs[stat] === null) {
      const value = prompt(`Observed ${stat.toUpperCase()} (allowed: ${result.possibleIvs[stat].join(', ')})`); if (value === null) return; observedIvs[stat] = Number(value)
    }
    const observedNature = result.natureGuaranteed ? undefined : prompt('Observed nature') as Nature | null
    if (!result.natureGuaranteed && !observedNature) return
    try { const next = await window.desktopApi.plans.completeStep({ planId: opened.id, stepId: nextStep.id, observedIvs, observedNature: observedNature ?? undefined }); setOpened(next); await refresh(); setNotice(`${nextStep.id} completed safely`) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const replace = async (missingId: string) => {
    if (!opened) return; const raw = prompt('Inventory ID of the purchased/caught breeder'); if (!raw) return
    try { const next = await window.desktopApi.plans.replaceMissing(opened.id, missingId, Number(raw)); setOpened(next); await refresh(); setNotice(`${missingId} replaced and tree revalidated`) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const recalculate = () => {
    if (!opened) return
    if (opened.status === 'In Progress' && !confirm('This plan has completed breeds. Recalculate will open a new search using the current inventory and will not modify this saved plan. Continue?')) return
    onRecalculate(opened.target)
  }
  return <section><div className="saved-layout"><div className="plan-list"><div className="panel-title"><h2>Saved plans</h2><span>{plans.length}</span></div>{plans.map((plan) => <button className={opened?.id === plan.id ? 'selected' : ''} key={plan.id} onClick={() => void load(plan.id)}><b>{plan.name}</b><span className={`status ${plan.status.toLowerCase().replace(' ', '-')}`}>{plan.status}</span><small>{new Date(plan.updatedAt).toLocaleString()}</small></button>)}</div>
    <div className="panel saved-detail">{opened ? <><div className="panel-title"><div><h2>{opened.name}</h2><small>{opened.status} · {opened.tree.steps.filter((s) => s.status === 'Completed').length}/{opened.tree.steps.length} completed</small></div><div className="actions-row"><button onClick={recalculate}>Recalculate</button><button disabled={!nextStep} className="primary" onClick={() => void complete()}>Breed Completed</button><button className="danger" onClick={async () => { if (confirm('Delete plan and release reserved breeders?')) { await window.desktopApi.plans.delete(opened.id); setOpened(null); await refresh() } }}>Delete</button></div></div>
      {opened.tree.missingBreeders.length > 0 && <div className="missing-strip">{opened.tree.missingBreeders.map((missing) => <button key={missing.id} onClick={() => void replace(missing.id)}><b>{missing.id.toUpperCase()}</b><span>{missing.eggGroups.join('+')} · {missing.gender}</span><small>Replace Missing Breeder</small></button>)}</div>}
      <PlanTree plan={opened.tree} species={species} onSelect={setSelectedNode} /></> : <div className="empty-state"><h2>Select a saved plan</h2></div>}</div></div>
    {selectedNode && <NodeDetail node={selectedNode} species={species} plan={opened?.tree ?? null} onClose={() => setSelectedNode(null)} />}</section>
}

function BackupView({ run }: { run(operation: () => Promise<unknown>, success: string): Promise<void> }) {
  const backup = async () => { const path = await window.desktopApi.dialog.save(`PokeMMOBreedingPlanner_Backup_${new Date().toISOString().slice(0, 10)}.pbpbackup`, [{ name: 'Planner backup', extensions: ['pbpbackup'] }]); if (path) await run(() => window.desktopApi.backup.create(path), `Backup saved: ${path}`) }
  const restore = async () => { const path = await window.desktopApi.dialog.open([{ name: 'Planner backup', extensions: ['pbpbackup'] }]); if (path && confirm('Validate and restore this backup? A safety snapshot of current data will be created first.')) await run(() => window.desktopApi.backup.restore(path), 'Backup restored; restart recommended') }
  const exportJson = async () => { const path = await window.desktopApi.dialog.save(`PokeMMO_Breeding_Export_${new Date().toISOString().slice(0, 10)}.json`, [{ name: 'JSON', extensions: ['json'] }]); if (path) await run(() => window.desktopApi.data.exportJson(path), `JSON exported: ${path}`) }
  const importJson = async () => { const path = await window.desktopApi.dialog.open([{ name: 'JSON', extensions: ['json'] }]); if (path && confirm('Validated JSON import replaces current data after a safety snapshot. Continue?')) await run(() => window.desktopApi.data.importJson(path), 'JSON imported') }
  const undoLast = async () => { if (confirm('Restore the latest automatic snapshot? This rolls the whole local database back to immediately before the last protected operation.')) await run(() => window.desktopApi.backup.undoLast(), 'Latest safety snapshot restored') }
  return <section className="backup-grid"><div className="panel backup-card"><span className="empty-icon">⬡</span><h2>Single-file backup</h2><p>SQLite snapshot plus manifest and schema version in a portable `.pbpbackup` archive.</p><button className="primary" onClick={() => void backup()}>Create Backup</button><button onClick={() => void restore()}>Restore Backup</button></div><div className="panel backup-card"><span className="empty-icon">↶</span><h2>Accidental breed recovery</h2><p>Breed Completed creates a validated automatic SQLite snapshot first. Restore the latest one here.</p><button onClick={() => void undoLast()}>Restore Latest Safety Snapshot</button></div><div className="panel backup-card"><span className="empty-icon">{'{ }'}</span><h2>Readable JSON</h2><p>Versioned inventory, boxes, targets, plans and settings. Imports are validated before writing.</p><button onClick={() => void exportJson()}>Export JSON</button><button onClick={() => void importJson()}>Import JSON</button></div></section>
}

function SettingsView({ run }: { run(operation: () => Promise<unknown>, success: string): Promise<void> }) {
  const [info, setInfo] = useState<{ version: string; development: boolean; databasePath: string } | null>(null)
  useEffect(() => { void window.desktopApi.app.info().then(setInfo) }, [])
  return <section><div className="panel settings"><h2>Local data</h2><dl><dt>Version</dt><dd>{info?.version}</dd><dt>Database</dt><dd>{info?.databasePath}</dd><dt>Mode</dt><dd>{info?.development ? 'Development (isolated database)' : 'Production'}</dd><dt>Ruleset</dt><dd>pokemmo-v1-2026-08-23</dd><dt>Species dataset</dt><dd>649 species, generated and bundled offline</dd></dl>{info?.development && <button onClick={() => void run(() => window.desktopApi.dev.loadDataset(), 'Loaded 50 development breeders')}>Load Development Dataset</button>}</div></section>
}
