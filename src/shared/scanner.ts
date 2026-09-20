import { NATURES, STATS } from './constants'
import type {
  Gender, Nature, NormalizedRoi, PokeMMOScanResult, ScanStatus, ScannerCalibration, ScannerThresholds, ScannedField, Species, Stat
} from './types'

export type RoiResizeHandle = 'nw' | 'ne' | 'se' | 'sw'
export type RoiProperty = keyof NormalizedRoi
export const MIN_NORMALIZED_ROI_SIZE = 0.003

export function isPokeMMOWindowName(name: string): boolean {
  // The Windows client can replace a different subset of PokeMMO with visually identical
  // Cyrillic/Greek characters on each launch (for example `РokеMМO`). Convert every
  // confusable character that can occur in the expected title before matching it.
  const confusables: Record<string, string> = {
    '\u0420': 'P', '\u0440': 'p', '\u03A1': 'P', '\u03C1': 'p',
    '\u041E': 'O', '\u043E': 'o', '\u039F': 'O', '\u03BF': 'o',
    '\u041A': 'K', '\u043A': 'k', '\u039A': 'K', '\u03BA': 'k',
    '\u0415': 'E', '\u0435': 'e', '\u0395': 'E', '\u03B5': 'e',
    '\u041C': 'M', '\u043C': 'm', '\u039C': 'M', '\u03BC': 'm'
  }
  const normalized = [...name.normalize('NFKC')].map((character) => confusables[character] ?? character).join('').trim()
  return /^PokeMMO(?:\s|$)/i.test(normalized) && !/Breeding Planner/i.test(normalized)
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))

export function moveNormalizedRoi(roi: NormalizedRoi, deltaX: number, deltaY: number): NormalizedRoi {
  return {
    ...roi,
    x: clamp(roi.x + deltaX, 0, 1 - roi.width),
    y: clamp(roi.y + deltaY, 0, 1 - roi.height)
  }
}

export function resizeNormalizedRoi(roi: NormalizedRoi, handle: RoiResizeHandle, deltaX: number, deltaY: number): NormalizedRoi {
  const right = roi.x + roi.width; const bottom = roi.y + roi.height
  let left = roi.x; let top = roi.y; let nextRight = right; let nextBottom = bottom
  if (handle.includes('w')) left = clamp(roi.x + deltaX, 0, right - MIN_NORMALIZED_ROI_SIZE)
  if (handle.includes('e')) nextRight = clamp(right + deltaX, roi.x + MIN_NORMALIZED_ROI_SIZE, 1)
  if (handle.includes('n')) top = clamp(roi.y + deltaY, 0, bottom - MIN_NORMALIZED_ROI_SIZE)
  if (handle.includes('s')) nextBottom = clamp(bottom + deltaY, roi.y + MIN_NORMALIZED_ROI_SIZE, 1)
  return { x: left, y: top, width: nextRight - left, height: nextBottom - top }
}

export function setNormalizedRoiProperty(roi: NormalizedRoi, property: RoiProperty, value: number): NormalizedRoi {
  const finite = Number.isFinite(value) ? value : 0
  if (property === 'x') return { ...roi, x: clamp(finite, 0, 1 - roi.width) }
  if (property === 'y') return { ...roi, y: clamp(finite, 0, 1 - roi.height) }
  if (property === 'width') return { ...roi, width: clamp(finite, MIN_NORMALIZED_ROI_SIZE, 1 - roi.x) }
  return { ...roi, height: clamp(finite, MIN_NORMALIZED_ROI_SIZE, 1 - roi.y) }
}

export const DEFAULT_SCANNER_CALIBRATION: ScannerCalibration = {
  version: 2,
  autoDetectBox: true,
  rois: {
    species: { x: 0.008, y: 0.392, width: 0.273, height: 0.072 },
    gender: { x: 0.008, y: 0.392, width: 0.273, height: 0.072 },
    ivs: { x: 0.008, y: 0.495, width: 0.273, height: 0.065 },
    nature: { x: 0.008, y: 0.588, width: 0.273, height: 0.067 },
    alpha: { x: 0.007, y: 0.04, width: 0.04, height: 0.07 },
    ha: { x: 0.008, y: 0.635, width: 0.273, height: 0.07 },
    fingerprint: { x: 0.04, y: 0.38, width: 0.23, height: 0.19 }
  },
  thresholds: { verified: 0.9, error: 0.7, alphaColorRatio: 0.012, haColorRatio: 0.006, genderColorRatio: 0.008 },
  stableFrames: 3,
  pollIntervalMs: 220
}

export interface DictionaryMatch<T> { value: T | null; score: number; ambiguous: boolean }

export function normalizeOcrText(value: string): string {
  return value.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase()
}

export function levenshtein(left: string, right: string): number {
  if (!left.length) return right.length
  if (!right.length) return left.length
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1)
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length] ?? Math.max(left.length, right.length)
}

export function matchDictionary<T>(raw: string, entries: Array<{ label: string; value: T }>, substring = false): DictionaryMatch<T> {
  const input = normalizeOcrText(raw)
  if (!input) return { value: null, score: 0, ambiguous: false }
  const ranked = entries.map((entry) => {
    const candidate = normalizeOcrText(entry.label)
    const distanceScore = 1 - levenshtein(input, candidate) / Math.max(input.length, candidate.length, 1)
    const contained = substring && input.includes(candidate)
    return { value: entry.value, score: contained ? Math.min(0.995, 0.97 + candidate.length / 1_000) : distanceScore }
  }).sort((a, b) => b.score - a.score)
  const best = ranked[0]
  const second = ranked[1]
  if (!best || best.score < 0.55) return { value: null, score: best?.score ?? 0, ambiguous: false }
  return { value: best.value, score: best.score, ambiguous: Boolean(second && best.score - second.score < 0.06) }
}

export function matchSpecies(raw: string, species: Species[]): DictionaryMatch<number> {
  const withoutLevel = raw.replace(/^\s*L[vV][.:]?\s*\d+\s*/i, '').replace(/[♂♀]/g, ' ')
  return matchDictionary(withoutLevel, species.map((entry) => ({ label: entry.name, value: entry.id })), true)
}

export function matchNature(raw: string): DictionaryMatch<Nature> {
  const entries = NATURES.map((nature) => ({ label: nature, value: nature }))
  const withoutUiLabel = raw.replace(/nature/gi, ' ')
  const candidates = [withoutUiLabel, ...(withoutUiLabel.match(/[a-zA-Z0-9]+/g) ?? [])]
  return candidates.map((candidate) => matchDictionary(candidate, entries, true))
    .sort((left, right) => right.score - left.score)[0] ?? { value: null, score: 0, ambiguous: false }
}

export function parseIvs(raw: string): { values: Record<Stat, number> | null; error?: string } {
  // The complete PokeMMO row may also OCR its `IVs:` label as a stray character.
  // Extract the one six-value slash sequence while still rejecting negatives or seven-value rows.
  const match = raw.trim().match(
    /(?:^|[^0-9\/-])((?:\d{1,2}\s*\/\s*){5}\d{1,2})(?!\s*[0-9/])/
  )
  if (!match?.[1]) return { values: null, error: 'IVs must contain exactly six slash-separated integers' }
  const values = match[1].replace(/\s/g, '').split('/').map(Number)
  const invalidIndex = values.findIndex((value) => !Number.isInteger(value) || value < 0 || value > 31)
  if (invalidIndex >= 0) return { values: null, error: `${STATS[invalidIndex]?.toUpperCase() ?? 'IV'} IV invalid: ${values[invalidIndex]}` }
  return { values: Object.fromEntries(STATS.map((stat, index) => [stat, values[index]])) as Record<Stat, number> }
}

export interface IvOcrCandidate { variant: string; text: string; confidence: number }
export interface IvOcrSelection {
  values: Record<Stat, number> | null
  confidences: Record<Stat, number>
  raw: string
  error?: string
}

export function selectIvOcrConsensus(candidates: IvOcrCandidate[]): IvOcrSelection {
  const raw = candidates.map((candidate) => `${candidate.variant}=${candidate.text || '∅'} (${Math.round(candidate.confidence * 100)}%)`).join(' | ')
  const parsed = candidates.map((candidate) => ({ candidate, parsed: parseIvs(candidate.text) }))
  const valid = parsed.filter((entry): entry is typeof entry & { parsed: { values: Record<Stat, number> } } => entry.parsed.values !== null)
  const emptyConfidence = Object.fromEntries(STATS.map((stat) => [stat, 0])) as Record<Stat, number>
  if (!valid.length) {
    const best = [...parsed].sort((left, right) => right.candidate.confidence - left.candidate.confidence)[0]
    return { values: null, confidences: emptyConfidence, raw, error: best?.parsed.error ?? 'IV OCR produced no usable reading' }
  }

  const groups = new Map<string, typeof valid>()
  for (const entry of valid) {
    const key = STATS.map((stat) => entry.parsed.values[stat]).join('/')
    const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group)
  }
  const ranked = [...groups.values()].sort((left, right) => {
    if (left.length !== right.length) return right.length - left.length
    const average = (group: typeof valid) => group.reduce((sum, entry) => sum + entry.candidate.confidence, 0) / group.length
    return average(right) - average(left)
  })
  const winner = ranked[0] as typeof valid
  // Vote per stat: independent errors in separate digits must not make an entire row win.
  const values = Object.fromEntries(STATS.map((stat) => {
    const votes = new Map<number, { count: number; confidence: number }>()
    for (const entry of valid) {
      const value = entry.parsed.values[stat]
      const vote = votes.get(value) ?? { count: 0, confidence: 0 }
      vote.count += 1; vote.confidence += entry.candidate.confidence; votes.set(value, vote)
    }
    const rankedVotes = [...votes].sort((a, b) => b[1].count - a[1].count || b[1].confidence - a[1].confidence || a[0] - b[0])
    return [stat, rankedVotes[0]![0]]
  })) as Record<Stat, number>
  const winnerConfidence = winner.reduce((sum, entry) => sum + entry.candidate.confidence, 0) / winner.length
  const confidences = Object.fromEntries(STATS.map((stat) => {
    const agreement = valid.filter((entry) => entry.parsed.values[stat] === values[stat]).length / valid.length
    const strongAgreement = valid.filter((entry) => entry.parsed.values[stat] === values[stat] && entry.candidate.confidence >= 0.6)
    const independentStrong = new Set(strongAgreement.filter((entry) => entry.candidate.confidence >= 0.8).map((entry) => entry.candidate.variant.replace(/-\d+$/, ''))).size >= 2
    if (strongAgreement.length >= 2 && agreement === 1 && (valid.length >= Math.ceil(candidates.length * 0.6) || independentStrong)) {
      const confidence = strongAgreement.reduce((sum, entry) => sum + entry.candidate.confidence, 0) / strongAgreement.length
      return [stat, clamp(0.94 + confidence * 0.05, 0.94, 0.99)]
    }
    if (valid.length === 1) return [stat, clamp(0.74 + winnerConfidence * 0.12, 0.74, 0.88)]
    return [stat, clamp(0.62 + agreement * 0.25, 0.62, 0.89)]
  })) as Record<Stat, number>
  return { values, confidences, raw }
}

export function fingerprintDistance(left: string, right: string): number {
  if (!left || !right || left.length !== right.length || left.length % 2 !== 0) return Number.POSITIVE_INFINITY
  let difference = 0; let samples = 0
  for (let index = 0; index < left.length; index += 2) {
    const a = Number.parseInt(left.slice(index, index + 2), 16); const b = Number.parseInt(right.slice(index, index + 2), 16)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY
    difference += Math.abs(a - b); samples += 1
  }
  return samples ? difference / samples / 15 : Number.POSITIVE_INFINITY
}

export function scanResultIdentity(result: PokeMMOScanResult): string {
  return JSON.stringify([
    result.species.value, result.gender.value, ...STATS.map((stat) => result.ivs[stat].value), result.nature.value,
    result.alpha.value, result.hiddenAbility.value
  ])
}

function isMissing<T>(field: ScannedField<T>): boolean { return field.value === null }

export function validateScanResult(result: PokeMMOScanResult, species: Species[], thresholds: ScannerThresholds): { status: ScanStatus; issues: string[] } {
  const issues: string[] = []
  const invalid: string[] = []
  const meta = result.species.value === null ? undefined : species.find((entry) => entry.id === result.species.value)
  if (!meta) invalid.push('Species is not present in the local dataset')
  if (isMissing(result.gender)) issues.push('Gender is uncertain')
  if (isMissing(result.nature)) issues.push('Nature is uncertain')
  if (isMissing(result.alpha)) issues.push('Alpha indicator is uncertain')
  if (isMissing(result.hiddenAbility)) issues.push('HA diamond is uncertain')
  for (const stat of STATS) if (isMissing(result.ivs[stat])) invalid.push(`${stat.toUpperCase()} IV is missing or invalid`)
  if (meta && result.gender.value !== null) {
    const validGender = scannerGenderCompatible(meta, result.gender.value)
    if (!validGender) invalid.push(`${meta.name} cannot have gender ${result.gender.value}`)
  }
  if (result.nature.value !== null && !NATURES.includes(result.nature.value)) invalid.push(`Unknown nature ${String(result.nature.value)}`)
  const fields: Array<ScannedField<unknown>> = [result.species, result.gender, ...STATS.map((stat) => result.ivs[stat]), result.nature, result.alpha, result.hiddenAbility]
  const minimum = Math.min(...fields.map((field) => field.confidence))
  issues.push(...fields.filter((field) => field.value !== null && field.confidence < thresholds.verified).map((field) => `Low confidence (${Math.round(field.confidence * 100)}%)`))
  if (invalid.length) return { status: 'Error', issues: [...invalid, ...issues] }
  if (fields.some(isMissing) || minimum < thresholds.verified) return { status: minimum < thresholds.error ? 'Error' : 'Needs Review', issues }
  return { status: 'Verified', issues: [] }
}

export function scannerGenderCompatible(meta: Species, gender: Gender): boolean {
  if (meta.gender.kind === 'genderless') return gender === 'Genderless'
  if (gender === 'Genderless') return false
  if (meta.gender.femaleEighths === 0) return gender === 'Male'
  if (meta.gender.femaleEighths === 8) return gender === 'Female'
  return true
}
