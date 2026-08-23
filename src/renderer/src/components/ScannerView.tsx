import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { NATURES, STATS } from '../../../shared/constants'
import {
  DEFAULT_SCANNER_CALIBRATION, fingerprintDistance, isPokeMMOWindowName, moveNormalizedRoi, resizeNormalizedRoi, scanResultIdentity,
  setNormalizedRoiProperty, validateScanResult,
  type RoiResizeHandle
} from '../../../shared/scanner'
import type {
  BoxRecord, Gender, InventoryInput, NormalizedRoi, PokeMMOScanResult, ScannerCalibration, ScannerImportSummary,
  ScannerPreview, ScannerRoiKey, ScannedField, Species, Stat
} from '../../../shared/types'

interface Props {
  active: boolean
  species: Species[]
  boxes: BoxRecord[]
  refresh(): Promise<void>
  setNotice(message: string): void
}

const ROI_LABELS: Record<ScannerRoiKey, string> = {
  species: 'Name row', gender: 'Name + gender row', ivs: 'IVs row', nature: 'Nature row', alpha: 'Alpha', ha: 'Ability + HA row', fingerprint: 'Change detection'
}
const ROI_KEYS = Object.keys(ROI_LABELS) as ScannerRoiKey[]
const RESIZE_HANDLES: RoiResizeHandle[] = ['nw', 'ne', 'se', 'sw']

interface RoiInteraction {
  pointerId: number
  key: ScannerRoiKey
  handle: RoiResizeHandle | null
  startX: number
  startY: number
  startRoi: NormalizedRoi
}

function cloneDefault(): ScannerCalibration { return structuredClone(DEFAULT_SCANNER_CALIBRATION) }
function percent(value: number): number { return Math.round(value * 1_000) / 10 }
function confidenceTitle(field: ScannedField<unknown>): string {
  return `${Math.round(field.confidence * 100)}%${field.raw ? ` · raw: ${field.raw}` : ''}`
}

function isCalibration(value: unknown): value is ScannerCalibration {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ScannerCalibration>
  return candidate.version === DEFAULT_SCANNER_CALIBRATION.version
    && Boolean(candidate.rois && candidate.thresholds && candidate.stableFrames && candidate.pollIntervalMs)
}

export function ScannerView({ active, species, boxes, refresh, setNotice }: Props) {
  const [sourceId, setSourceId] = useState('')
  const [sourceChecking, setSourceChecking] = useState(false)
  const [boxId, setBoxId] = useState('')
  const [calibration, setCalibration] = useState<ScannerCalibration>(cloneDefault)
  const [preview, setPreview] = useState<ScannerPreview | null>(null)
  const [queue, setQueue] = useState<PokeMMOScanResult[]>([])
  const [lastResult, setLastResult] = useState<PokeMMOScanResult | null>(null)
  const [showCrops, setShowCrops] = useState(false)
  const [debugSave, setDebugSave] = useState(false)
  const [calibrating, setCalibrating] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [live, setLive] = useState(false)
  const [stability, setStability] = useState(0)
  const [hotkey, setHotkey] = useState('Ctrl+Shift+S')
  const [hotkeyEnabled, setHotkeyEnabled] = useState(false)
  const [summary, setSummary] = useState<ScannerImportSummary | null>(null)
  const [importError, setImportError] = useState('')
  const [activeRoi, setActiveRoi] = useState<ScannerRoiKey>('species')
  const activeHotkey = useRef<{ sourceId: string; calibration: ScannerCalibration; accelerator: string } | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const roiInteraction = useRef<RoiInteraction | null>(null)
  const candidate = useRef(''); const candidateFrames = useRef(0); const lastCaptured = useRef(''); const liveBusy = useRef(false)
  const lastAutomaticIdentity = useRef(''); const lastAutomaticScanAt = useRef(0)
  const speciesMap = useMemo(() => new Map(species.map((entry) => [entry.id, entry])), [species])
  const selectedBox = boxes.find((box) => box.id === Number(boxId))
  const locked = queue.length > 0 || live || hotkeyEnabled

  const refreshSources = async () => {
    setSourceChecking(true)
    try {
      const next = await window.desktopApi.scanner.sources()
      setSourceId(next.find((entry) => isPokeMMOWindowName(entry.name))?.id ?? '')
    } catch (error) { setSourceId(''); setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setSourceChecking(false) }
  }

  useEffect(() => {
    void window.desktopApi.settings.get().then((settings) => {
      if (isCalibration(settings['scanner.calibration'])) setCalibration(settings['scanner.calibration'])
      if (typeof settings['scanner.hotkey'] === 'string') setHotkey(settings['scanner.hotkey'])
    })
  }, [])
  useEffect(() => { if (active) void refreshSources() }, [active])

  useEffect(() => {
    const removeCapture = window.desktopApi.scanner.onCaptured((result) => {
      setQueue((current) => [...current, result]); setLastResult(result); setNotice(`${speciesMap.get(result.species.value ?? -1)?.name ?? 'Pokémon'} captured · ${result.status}`)
    })
    const removeError = window.desktopApi.scanner.onError(setNotice)
    return () => { removeCapture(); removeError() }
  }, [setNotice, speciesMap])

  useEffect(() => () => {
    const config = activeHotkey.current
    if (config) void window.desktopApi.scanner.setHotkey({ ...config, enabled: false })
  }, [])

  const addResult = (result: PokeMMOScanResult) => {
    setQueue((current) => [...current, result]); setLastResult(result)
  }

  const requireSession = (): boolean => {
    if (!sourceId) { setNotice('PokeMMO was not found. Open the game and return to Box Scanner.'); return false }
    if (!boxId) { setNotice('Select a Destination Box first'); return false }
    return true
  }

  const scanCurrent = async (forceDebug = false) => {
    if (!requireSession() || scanning) return
    setScanning(true)
    try {
      const result = await window.desktopApi.scanner.scanCurrent({ sourceId, calibration, includeCrops: showCrops, debugSave: debugSave || forceDebug })
      addResult(result); setNotice(`${speciesMap.get(result.species.value ?? -1)?.name ?? 'Scan'} · ${result.status}`)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); void refreshSources() }
    finally { setScanning(false) }
  }

  useEffect(() => {
    if (!live) return
    let cancelled = false; let timer = 0
    const tick = async () => {
      try {
        const reading = await window.desktopApi.scanner.fingerprint(sourceId, calibration)
        if (cancelled) return
        if (fingerprintDistance(candidate.current, reading.value) <= 0.045) candidateFrames.current += 1
        else { candidate.current = reading.value; candidateFrames.current = 1 }
        setStability(candidateFrames.current)
        const firstCapture = !lastCaptured.current
        const changed = fingerprintDistance(lastCaptured.current, reading.value) > 0.055
        const fallbackDue = Date.now() - lastAutomaticScanAt.current >= 2_500
        if ((firstCapture || (candidateFrames.current >= 2 && changed) || fallbackDue) && !liveBusy.current) {
          liveBusy.current = true
          try {
            const result = await window.desktopApi.scanner.scanCurrent({ sourceId, calibration, includeCrops: showCrops, debugSave })
            if (!cancelled) {
              const identity = scanResultIdentity(result)
              if (identity !== lastAutomaticIdentity.current) {
                addResult(result); lastAutomaticIdentity.current = identity
                setNotice(`${speciesMap.get(result.species.value ?? -1)?.name ?? 'Pokémon'} captured automatically`)
              }
              lastCaptured.current = result.fingerprint; candidate.current = result.fingerprint; candidateFrames.current = 1
              lastAutomaticScanAt.current = Date.now()
            }
          } finally { liveBusy.current = false }
        }
      } catch (error) {
        if (!cancelled) { setNotice(error instanceof Error ? error.message : String(error)); setLive(false); void refreshSources() }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), calibration.pollIntervalMs)
    }
    void tick()
    return () => { cancelled = true; window.clearTimeout(timer); liveBusy.current = false }
  }, [live, sourceId, calibration, showCrops, debugSave, setNotice, speciesMap])

  const startLive = () => {
    if (!requireSession()) return
    candidate.current = ''; candidateFrames.current = 0; lastCaptured.current = ''; lastAutomaticIdentity.current = ''; lastAutomaticScanAt.current = 0
    setStability(0); setNotice('Live scanning started · capturing the current Pokémon…'); setLive(true)
  }

  const toggleHotkey = async () => {
    if (!hotkeyEnabled && !requireSession()) return
    const config = { sourceId, calibration, accelerator: hotkey, includeCrops: showCrops, debugSave, enabled: !hotkeyEnabled }
    try {
      const result = await window.desktopApi.scanner.setHotkey(config)
      setNotice(result.message)
      setHotkeyEnabled(result.registered)
      activeHotkey.current = result.registered ? { sourceId, calibration, accelerator: hotkey } : null
      if (result.registered) await window.desktopApi.settings.set('scanner.hotkey', hotkey)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); void refreshSources() }
  }

  const capturePreview = async () => {
    if (!sourceId) { setNotice('PokeMMO was not found. Open the game and return to Box Scanner.'); return }
    try {
      const next = await window.desktopApi.scanner.preview(sourceId); setSourceId(next.sourceId); setPreview(next); setCalibrating(true)
      if (next.suggestedRois) {
        setCalibration((current) => ({ ...current, autoDetectBox: true, rois: next.suggestedRois! }))
        setNotice(`PC Deposit Box detected automatically · ${Math.round((next.detectionConfidence ?? 0) * 100)}%`)
      } else setNotice('PC Deposit Box was not detected. Keep it open and fully visible, or use manual calibration.')
    }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); void refreshSources() }
  }

  const saveCalibration = async () => {
    try { await window.desktopApi.settings.set('scanner.calibration', calibration); setCalibrating(false); setNotice('PokeMMO calibration saved locally') }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }

  const updateRoi = (key: ScannerRoiKey, property: keyof NormalizedRoi, raw: string) => {
    if (!raw.trim()) return
    const value = Number(raw) / 100
    if (!Number.isFinite(value)) return
    setCalibration((current) => ({ ...current, rois: { ...current.rois, [key]: setNormalizedRoiProperty(current.rois[key], property, value) } }))
  }

  const pointerPosition = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = previewRef.current?.getBoundingClientRect()
    if (!rect?.width || !rect.height) return null
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height }
  }

  const startRoiInteraction = (event: ReactPointerEvent<HTMLElement>, key: ScannerRoiKey, handle: RoiResizeHandle | null) => {
    if (event.button !== 0) return
    const point = pointerPosition(event.clientX, event.clientY); if (!point) return
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setActiveRoi(key)
    roiInteraction.current = { pointerId: event.pointerId, key, handle, startX: point.x, startY: point.y, startRoi: { ...calibration.rois[key] } }
  }

  const moveRoiInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = roiInteraction.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    const point = pointerPosition(event.clientX, event.clientY); if (!point) return
    const deltaX = point.x - interaction.startX; const deltaY = point.y - interaction.startY
    const nextRoi = interaction.handle
      ? resizeNormalizedRoi(interaction.startRoi, interaction.handle, deltaX, deltaY)
      : moveNormalizedRoi(interaction.startRoi, deltaX, deltaY)
    setCalibration((current) => ({ ...current, rois: { ...current.rois, [interaction.key]: nextRoi } }))
  }

  const endRoiInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (roiInteraction.current?.pointerId === event.pointerId) roiInteraction.current = null
  }

  const manualEdit = (id: string, edit: (result: PokeMMOScanResult) => void) => {
    setQueue((current) => current.map((entry) => {
      if (entry.id !== id) return entry
      const result = structuredClone(entry); edit(result)
      const validation = validateScanResult(result, species, calibration.thresholds)
      result.status = validation.status; result.issues = validation.issues
      return result
    }))
  }

  const setManual = <T,>(field: ScannedField<T>, value: T | null) => { field.value = value; field.confidence = 1; field.raw = 'manual review' }

  const approveReview = (id: string) => {
    const current = queue.find((entry) => entry.id === id); if (!current) return
    const result = structuredClone(current)
    const fields: Array<ScannedField<unknown>> = [result.species, result.gender, ...STATS.map((stat) => result.ivs[stat]), result.nature, result.alpha, result.hiddenAbility]
    if (fields.some((field) => field.value === null)) { setNotice('Complete every field marked ? before approving this scan'); return }
    for (const field of fields) { field.confidence = 1; field.raw = `${field.raw ?? ''}${field.raw ? ' · ' : ''}manually approved` }
    const validation = validateScanResult(result, species, calibration.thresholds)
    result.status = validation.status; result.issues = validation.issues
    if (result.status !== 'Verified') { setNotice(validation.issues.join(' · ') || 'This row still contains invalid data'); return }
    setQueue((entries) => entries.map((entry) => entry.id === id ? result : entry)); setLastResult(result); setNotice('Scan approved manually and ready to import')
  }

  const importVerified = async () => {
    if (!selectedBox) { setNotice('Destination Box is missing'); return }
    const checkedQueue = queue.map((entry) => {
      const checked = structuredClone(entry)
      const validation = validateScanResult(checked, species, calibration.thresholds)
      checked.status = validation.status; checked.issues = validation.issues
      return checked
    })
    const verified = checkedQueue.filter((entry) => entry.status === 'Verified')
    const skipped = checkedQueue.filter((entry) => entry.status === 'Needs Review').length
    const validationErrors = checkedQueue.filter((entry) => entry.status === 'Error').length
    setQueue(checkedQueue); setImportError('')
    if (!verified.length) {
      setSummary({ added: 0, skipped, errors: validationErrors, boxName: selectedBox.name })
      setNotice(validationErrors ? 'No importable scans: check the reason shown below each invalid row' : 'There are no Verified scans to import')
      return
    }
    const inputs: InventoryInput[] = verified.map((entry) => ({
      speciesId: entry.species.value as number, gender: entry.gender.value as Gender,
      ivs: Object.fromEntries(STATS.map((stat) => [stat, entry.ivs[stat].value])) as InventoryInput['ivs'],
      nature: entry.nature.value!, alpha: entry.alpha.value!, ha: entry.hiddenAbility.value!, boxId: selectedBox.id,
      notes: `PokeMMO Box Scanner · ${entry.capturedAt}`
    }))
    try {
      const added = await window.desktopApi.inventory.bulkCreate(inputs)
      const importedIds = new Set(verified.map((entry) => entry.id))
      setSummary({ added: added.length, skipped, errors: validationErrors, boxName: selectedBox.name })
      setQueue(checkedQueue.filter((entry) => !importedIds.has(entry.id)))
      await refresh()
      const retained = skipped + validationErrors
      setNotice(`Import completed · ${added.length} added to ${selectedBox.name}${retained ? ` · ${retained} kept in review` : ''}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSummary({ added: 0, skipped, errors: validationErrors + verified.length, boxName: selectedBox.name })
      setImportError(message)
      setNotice('Import not completed. The complete error is shown above the Review Queue.')
    }
  }

  const counts = { verified: queue.filter((entry) => entry.status === 'Verified').length, review: queue.filter((entry) => entry.status === 'Needs Review').length, error: queue.filter((entry) => entry.status === 'Error').length }

  return <section className="scanner-layout">
    <div className="panel scanner-controls">
      <div className="panel-title"><h2>PokeMMO Box Scanner</h2><span className={`badge ${sourceId ? 'verified' : 'source-missing'}`}>{live ? 'SCANNING' : sourceChecking ? 'FINDING POKEMMO' : sourceId ? 'POKEMMO READY' : 'POKEMMO NOT FOUND'}</span></div>
      {!sourceId && !sourceChecking && <button disabled={locked} onClick={() => void refreshSources()}>Find PokeMMO</button>}
      <label>Destination Box<select disabled={locked} value={boxId} onChange={(event) => { setBoxId(event.target.value); setSummary(null); setImportError('') }}><option value="">Select a box</option>{boxes.map((box) => <option key={box.id} value={box.id}>{box.name}</option>)}</select></label>
      <div className="scanner-calibration-state"><span>Calibration</span><b>{preview ? `${preview.width}×${preview.height}` : 'Automatic Box detection'}</b><button disabled={locked || !sourceId} onClick={() => void capturePreview()}>Detect / Recalibrate</button></div>
      <label className="check"><input type="checkbox" disabled={live || hotkeyEnabled} checked={calibration.autoDetectBox !== false} onChange={(event) => setCalibration((current) => ({ ...current, autoDetectBox: event.target.checked }))} /> Detect PC Deposit Box automatically</label>
      <div className="scanner-counts"><div><b>{queue.length}</b><small>Detected</small></div><div><b>{counts.verified}</b><small>Verified</small></div><div><b>{counts.review}</b><small>Needs Review</small></div><div><b>{counts.error}</b><small>Errors</small></div></div>
      <button className="primary scanner-start" disabled={!sourceId || live || scanning} onClick={startLive}>Start scanning</button>
      {live && <button className="danger scanner-start" onClick={() => setLive(false)}>Stop scanning · stable {Math.min(stability, calibration.stableFrames)}/{calibration.stableFrames}</button>}
      <button disabled={!sourceId || scanning || live} onClick={() => void scanCurrent()}>{scanning ? 'Recognizing…' : 'Scan Current Pokémon'}</button>
      <div className="hotkey-row"><input disabled={hotkeyEnabled} value={hotkey} onChange={(event) => setHotkey(event.target.value)} /><button disabled={!sourceId && !hotkeyEnabled} onClick={() => void toggleHotkey()}>{hotkeyEnabled ? 'Disable hotkey' : 'Enable hotkey'}</button></div>
      <label className="check"><input type="checkbox" checked={showCrops} onChange={(event) => setShowCrops(event.target.checked)} /> Show Debug Crops</label>
      <label className="check"><input type="checkbox" checked={debugSave} onChange={(event) => setDebugSave(event.target.checked)} /> Save scan files locally (debug)</label>
      {queue.length > 0 && !live && !hotkeyEnabled && <button className="danger" onClick={() => { setQueue([]); setLastResult(null); setSummary(null); setImportError('') }}>Clear session</button>}
    </div>

    <div className="scanner-workspace">
      {calibrating && preview && <div className="panel calibration-panel"><div className="panel-title"><div><h2>Calibrate PokeMMO</h2><small>{preview.detectedBox ? `PC Deposit Box detected automatically · ${Math.round((preview.detectionConfidence ?? 0) * 100)}%. Manual areas are optional fine tuning.` : 'Automatic detection failed. Drag the colored areas only as a manual fallback.'}</small></div><div><button onClick={() => setCalibration(cloneDefault())}>Reset</button><button className="primary" onClick={() => void saveCalibration()}>Save Calibration</button></div></div>
        <div className="calibration-grid"><div ref={previewRef} className="scanner-preview" onPointerMove={moveRoiInteraction} onPointerUp={endRoiInteraction} onPointerCancel={endRoiInteraction}><img draggable={false} src={preview.dataUrl} alt="Captured PokeMMO window" />{ROI_KEYS.map((key) => {
          const roi = calibration.rois[key]
          return <div key={key} title={`Drag ${ROI_LABELS[key]}`} className={`roi roi-${key} ${activeRoi === key ? 'active' : ''}`} style={{ left: `${roi.x * 100}%`, top: `${roi.y * 100}%`, width: `${roi.width * 100}%`, height: `${roi.height * 100}%`, zIndex: activeRoi === key ? 20 : key === 'fingerprint' ? 1 : 2 }} onPointerDown={(event) => startRoiInteraction(event, key, null)}><span className="roi-label">{ROI_LABELS[key]}</span>{RESIZE_HANDLES.map((handle) => <span key={handle} className={`roi-handle roi-handle-${handle}`} onPointerDown={(event) => startRoiInteraction(event, key, handle)} />)}</div>
        })}</div>
          <div className="roi-editor"><p>Select an area here or on the image, then drag it. The values below remain available for fine tuning.</p>{ROI_KEYS.map((key) => <fieldset className={activeRoi === key ? 'active' : ''} onPointerDown={() => setActiveRoi(key)} key={key}><legend>{ROI_LABELS[key]}</legend>{(['x', 'y', 'width', 'height'] as const).map((property) => <label key={property}>{property}<input type="number" min="0" max="100" step="0.1" value={percent(calibration.rois[key][property])} onChange={(event) => updateRoi(key, property, event.target.value)} /></label>)}</fieldset>)}</div></div></div>}

      {summary && <div className={`panel import-summary ${summary.added === 0 && summary.errors ? 'has-errors' : ''}`}><h2>{summary.added > 0 ? 'Import completed' : 'Import not completed'}</h2><b>Added: {summary.added}</b><b>Needs review: {summary.skipped}</b><b>Errors: {summary.errors}</b><span>Box: {summary.boxName}</span>{importError && <p className="import-error-detail"><b>Complete error:</b> {importError}</p>}</div>}

      <div className="panel review-panel"><div className="panel-title"><h2>Review Queue</h2><button className="primary" disabled={!counts.verified || live} onClick={() => void importVerified()}>Import Verified ({counts.verified})</button></div>
        {queue.length === 0 ? <div className="scanner-empty"><b>No captures yet</b><span>Select PokeMMO and a destination Box, then scan the selected Pokémon.</span></div> : <div className="table-wrap scanner-table"><table><thead><tr><th>Species</th><th>Sex</th>{STATS.map((stat) => <th key={stat}>{stat}</th>)}<th>Nature</th><th>Alpha</th><th>HA</th><th>Status</th><th>Review</th></tr></thead><tbody>{queue.map((entry) => <tr key={entry.id} className={entry.status === 'Error' ? 'row-error' : ''}>
          <td><select title={confidenceTitle(entry.species)} className={entry.species.confidence < calibration.thresholds.verified ? 'uncertain-field' : ''} value={entry.species.value ?? ''} onChange={(event) => manualEdit(entry.id, (result) => setManual(result.species, event.target.value ? Number(event.target.value) : null))}><option value="">?</option>{species.map((meta) => <option key={meta.id} value={meta.id}>{meta.name}</option>)}</select></td>
          <td><select title={confidenceTitle(entry.gender)} className={entry.gender.confidence < calibration.thresholds.verified ? 'uncertain-field' : ''} value={entry.gender.value ?? ''} onChange={(event) => manualEdit(entry.id, (result) => setManual(result.gender, (event.target.value || null) as Gender | null))}><option value="">?</option><option>Male</option><option>Female</option><option>Genderless</option></select></td>
          {STATS.map((stat) => <td key={stat}><input title={confidenceTitle(entry.ivs[stat])} className={entry.ivs[stat].confidence < calibration.thresholds.verified ? 'uncertain-field' : ''} type="number" min="0" max="31" value={entry.ivs[stat].value ?? ''} onChange={(event) => manualEdit(entry.id, (result) => setManual(result.ivs[stat], event.target.value === '' ? null : Number(event.target.value)))} /></td>)}
          <td><select title={confidenceTitle(entry.nature)} className={entry.nature.confidence < calibration.thresholds.verified ? 'uncertain-field' : ''} value={entry.nature.value ?? ''} onChange={(event) => manualEdit(entry.id, (result) => setManual(result.nature, (event.target.value || null) as typeof result.nature.value))}><option value="">?</option>{NATURES.map((nature) => <option key={nature}>{nature}</option>)}</select></td>
          <td><select title={confidenceTitle(entry.alpha)} className={entry.alpha.confidence < calibration.thresholds.verified ? 'uncertain-field' : ''} value={entry.alpha.value === null ? '' : String(entry.alpha.value)} onChange={(event) => manualEdit(entry.id, (result) => setManual(result.alpha, event.target.value === '' ? null : event.target.value === 'true'))}><option value="">?</option><option value="true">Yes</option><option value="false">No</option></select></td>
          <td><select title={confidenceTitle(entry.hiddenAbility)} className={entry.hiddenAbility.confidence < calibration.thresholds.verified ? 'uncertain-field' : ''} value={entry.hiddenAbility.value === null ? '' : String(entry.hiddenAbility.value)} onChange={(event) => manualEdit(entry.id, (result) => setManual(result.hiddenAbility, event.target.value === '' ? null : event.target.value === 'true'))}><option value="">?</option><option value="true">Yes</option><option value="false">No</option></select></td>
          <td><span title={entry.issues.join('\n')} className={`status ${entry.status.toLowerCase().replace(' ', '-')}`}>{entry.status}</span></td><td className="scanner-row-actions">{entry.status === 'Verified' ? <span className="badge verified">APPROVED</span> : <button className="icon primary" onClick={() => approveReview(entry.id)}>✓ OK</button>}<button className="icon danger" onClick={() => setQueue((current) => current.filter((row) => row.id !== entry.id))}>×</button></td>
        </tr>)}</tbody></table></div>}
        {queue.some((entry) => entry.issues.length) && <div className="scan-issues">{queue.filter((entry) => entry.issues.length).map((entry) => <p key={entry.id}><b>{speciesMap.get(entry.species.value ?? -1)?.name ?? 'Unknown scan'}:</b> {entry.issues.join(' · ')}</p>)}</div>}
      </div>

      {showCrops && lastResult?.crops && <div className="panel debug-crops"><div className="panel-title"><h2>Debug Crops</h2>{lastResult.status !== 'Verified' && <button onClick={() => void scanCurrent(true)}>Save Failed Scan</button>}</div><div>{Object.entries(lastResult.crops).map(([key, dataUrl]) => <figure key={key}><figcaption>{ROI_LABELS[key as ScannerRoiKey]}</figcaption><img src={dataUrl} alt={`${key} ROI`} /></figure>)}</div>{lastResult.debugDirectory && <small>Saved locally: {lastResult.debugDirectory}</small>}</div>}
    </div>
  </section>
}
