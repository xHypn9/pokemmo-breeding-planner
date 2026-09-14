import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp, { type Sharp } from 'sharp'
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js'
import { STATS } from '../../shared/constants'
import { matchNature, matchSpecies, selectIvOcrConsensus, validateScanResult, type IvOcrCandidate } from '../../shared/scanner'
import type {
  Gender, NormalizedRoi, PokeMMOScanResult, ScannerCalibration, ScannerRoiKey, Species
} from '../../shared/types'

type CropKey = Exclude<ScannerRoiKey, 'fingerprint'>
interface OcrReading { text: string; confidence: number }
export interface RgbStats {
  red: number
  cyan: number
  blue: number
  pink: number
  yellow?: number
  redPixels?: number
  cyanPixels?: number
  bluePixels?: number
  pinkPixels?: number
  yellowPixels?: number
  pixelCount?: number
}

const clamp = (value: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value))
const asDataUrl = (buffer: Buffer) => `data:image/png;base64,${buffer.toString('base64')}`

function cropRect(width: number, height: number, roi: NormalizedRoi): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.min(width - 1, Math.floor(roi.x * width)))
  const top = Math.max(0, Math.min(height - 1, Math.floor(roi.y * height)))
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(roi.width * width)))
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(roi.height * height)))
  return { left, top, width: cropWidth, height: cropHeight }
}

async function preprocessNatureVariants(buffer: Buffer): Promise<Array<{ variant: string; image: Buffer }>> {
  const base = sharp(buffer).resize({ height: 180, kernel: 'lanczos3' }).grayscale().normalize()
  return Promise.all([115, 145, 175].map(async (threshold) => ({
    variant: `threshold-${threshold}`,
    image: await base.clone().threshold(threshold).png().toBuffer()
  })))
}

async function preprocessSpeciesVariants(buffer: Buffer): Promise<Array<{ variant: string; image: Buffer }>> {
  const base = sharp(buffer).resize({ height: 180, kernel: 'lanczos3' }).grayscale().normalize()
  return Promise.all([120, 150, 180].map(async (threshold) => ({
    variant: `threshold-${threshold}`,
    image: await base.clone().threshold(threshold).png().toBuffer()
  })))
}

async function preprocessIvVariants(buffer: Buffer): Promise<Array<{ variant: string; image: Buffer }>> {
  const base = sharp(buffer).resize({ height: 240, kernel: 'lanczos3' }).grayscale().normalize()
  const thresholds = await Promise.all([90, 100, 110].map(async (threshold) => ({
    variant: `threshold-${threshold}`,
    image: await base.clone().threshold(threshold).png().toBuffer()
  })))
  // Preserve stroke shapes in independent views instead of relying only on nearby thresholds.
  return [...thresholds,
    { variant: 'nearest-original', image: await sharp(buffer).resize({ height: 160, kernel: 'nearest' }).png().toBuffer() },
    { variant: 'grayscale-inverted', image: await sharp(buffer).resize({ height: 180, kernel: 'lanczos3' }).grayscale().normalize().negate().extend({ top: 16, bottom: 16, left: 16, right: 16, background: 'white' }).png().toBuffer() }
  ]
}

async function rgbStats(buffer: Buffer): Promise<RgbStats> {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let red = 0; let cyan = 0; let blue = 0; let pink = 0; let yellow = 0
  const pixels = Math.max(1, info.width * info.height)
  for (let index = 0; index < data.length; index += info.channels) {
    const r = data[index] ?? 0; const g = data[index + 1] ?? 0; const b = data[index + 2] ?? 0
    if (r > 130 && r > g * 1.35 && r > b * 1.05) red += 1
    if (g > 140 && b > 150 && b > r * 1.25 && g > r * 1.25) cyan += 1
    if (b > 130 && b > r * 1.35 && g > r * 1.1) blue += 1
    if (r > 170 && b > 100 && r > g * 1.5 && b > g * 1.1) pink += 1
    if (r > 140 && g > 80 && r > b * 1.4 && g > b * 1.2) yellow += 1
  }
  return {
    red: red / pixels, cyan: cyan / pixels, blue: blue / pixels, pink: pink / pixels, yellow: yellow / pixels,
    redPixels: red, cyanPixels: cyan, bluePixels: blue, pinkPixels: pink, yellowPixels: yellow, pixelCount: pixels
  }
}

function visualBoolean(ratio: number, threshold: number): { value: boolean | null; confidence: number } {
  const distance = Math.abs(ratio - threshold) / Math.max(threshold, 0.0001)
  const confidence = clamp(0.55 + Math.min(1, distance) * 0.44, 0, 0.99)
  return { value: confidence < 0.7 ? null : ratio >= threshold, confidence }
}

export function detectAlphaFromRgb(stats: RgbStats, threshold: number): { value: boolean | null; confidence: number } {
  return visualBoolean(stats.red, threshold)
}

export function detectHaFromRgb(stats: RgbStats, threshold: number): { value: boolean | null; confidence: number } {
  const diamondRatio = Math.max(stats.cyan, stats.blue)
  const abilityGoldRatio = stats.yellow ?? 0
  const hasPixelCounts = stats.pixelCount !== undefined
  const diamondPixels = Math.max(stats.cyanPixels ?? 0, stats.bluePixels ?? 0)
  const abilityGoldPixels = stats.yellowPixels ?? 0
  // HA is displayed by PokeMMO with two independent cues on the Ability row:
  // golden/orange ability text and the cyan diamond. Requiring both avoids false positives.
  const diamondPresent = hasPixelCounts ? diamondPixels >= 8 : diamondRatio >= threshold
  const abilityGoldPresent = hasPixelCounts ? abilityGoldPixels >= 12 : abilityGoldRatio >= threshold
  if (diamondPresent && abilityGoldPresent) return { value: true, confidence: 0.97 }
  if (!diamondPresent && !abilityGoldPresent) return { value: false, confidence: 0.96 }
  return { value: null, confidence: 0.62 }
}

export function detectGenderFromRgb(stats: RgbStats, threshold: number, genderless: boolean): { value: Gender | null; confidence: number } {
  const hasPixelCounts = stats.pixelCount !== undefined
  const male = hasPixelCounts ? Math.max(stats.cyanPixels ?? 0, stats.bluePixels ?? 0) : Math.max(stats.cyan, stats.blue)
  const female = hasPixelCounts ? stats.pinkPixels ?? 0 : stats.pink
  const evidenceThreshold = hasPixelCounts ? 8 : threshold
  if (genderless) return { value: 'Genderless', confidence: 0.98 }
  const strongest = Math.max(male, female); const weakest = Math.min(male, female)
  const separation = (strongest - weakest) / Math.max(strongest, evidenceThreshold)
  if (strongest < evidenceThreshold) {
    if (strongest < evidenceThreshold * 0.25 || separation < 0.3) return { value: null, confidence: 0.65 }
    return { value: male > female ? 'Male' : 'Female', confidence: clamp(0.7 + separation * 0.16, 0.7, 0.86) }
  }
  const confidence = clamp(0.72 + separation * 0.27, 0, 0.99)
  if (separation < 0.2) return { value: null, confidence: 0.6 }
  return { value: male > female ? 'Male' : 'Female', confidence }
}

export class RecognitionEngine {
  private workerPromise: Promise<Worker> | null = null
  private ocrQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly language: { langPath: string; gzip: boolean },
    private readonly debugRoot: string
  ) {}

  private worker(): Promise<Worker> {
    this.workerPromise ??= createWorker('eng', OEM.LSTM_ONLY, {
      langPath: this.language.langPath, gzip: this.language.gzip, cacheMethod: 'none'
    })
    return this.workerPromise
  }

  private async ocr(buffer: Buffer, whitelist: string): Promise<OcrReading> {
    const reading = this.ocrQueue.then(async () => {
      const worker = await this.worker()
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: whitelist })
      const result = await worker.recognize(buffer)
      return { text: result.data.text.trim(), confidence: clamp(result.data.confidence / 100) }
    })
    this.ocrQueue = reading.then(() => undefined, () => undefined)
    return reading
  }

  private async ocrIvs(buffer: Buffer) {
    const readings: IvOcrCandidate[] = []
    for (const variant of await preprocessIvVariants(buffer)) {
      const reading = await this.ocr(variant.image, '0123456789/')
      readings.push({ variant: variant.variant, ...reading })
    }
    return selectIvOcrConsensus(readings)
  }

  private async ocrSpecies(buffer: Buffer, species: Species[]) {
    const readings: Array<{ variant: string; text: string; confidence: number; match: ReturnType<typeof matchSpecies> }> = []
    for (const variant of await preprocessSpeciesVariants(buffer)) {
      const reading = await this.ocr(variant.image, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789. -')
      readings.push({ variant: variant.variant, ...reading, match: matchSpecies(reading.text, species) })
    }
    const valid = readings.filter((entry) => entry.match.value !== null)
    const groups = new Map<number, typeof valid>()
    for (const entry of valid) {
      const id = entry.match.value as number; const group = groups.get(id) ?? []; group.push(entry); groups.set(id, group)
    }
    const score = (entry: typeof readings[number]) => entry.match.score * 0.9 + entry.confidence * 0.1
    const winner = [...groups.values()].sort((left, right) => right.length - left.length || Math.max(...right.map(score)) - Math.max(...left.map(score)))[0]
    const selected = winner?.sort((left, right) => score(right) - score(left))[0] ?? readings.sort((left, right) => score(right) - score(left))[0]!
    const conflicting = groups.size > 1
    const confidence = !selected.match.value ? Math.min(0.49, selected.confidence)
      : winner && winner.length >= 2 && !conflicting ? clamp(score(selected))
        : Math.min(conflicting ? 0.82 : 0.86, score(selected))
    return {
      value: selected.match.value, confidence,
      raw: readings.map((entry) => `${entry.variant}=${entry.text || '∅'} (${Math.round(entry.confidence * 100)}%)`).join(' | ')
    }
  }

  private async ocrNature(buffer: Buffer) {
    const readings: Array<{ variant: string; text: string; confidence: number; match: ReturnType<typeof matchNature> }> = []
    for (const variant of await preprocessNatureVariants(buffer)) {
      const reading = await this.ocr(variant.image, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789[]+-/ :')
      readings.push({ variant: variant.variant, ...reading, match: matchNature(reading.text) })
    }
    const valid = readings.filter((entry) => entry.match.value !== null)
    const groups = new Map<string, typeof valid>()
    for (const entry of valid) {
      const nature = entry.match.value as string; const group = groups.get(nature) ?? []; group.push(entry); groups.set(nature, group)
    }
    const score = (entry: typeof readings[number]) => entry.match.score * 0.9 + entry.confidence * 0.1
    const winner = [...groups.values()].sort((left, right) => right.length - left.length || Math.max(...right.map(score)) - Math.max(...left.map(score)))[0]
    const selected = winner?.sort((left, right) => score(right) - score(left))[0] ?? readings.sort((left, right) => score(right) - score(left))[0]!
    const conflicting = groups.size > 1
    const confidence = !selected.match.value ? Math.min(0.49, selected.confidence)
      : winner && winner.length >= 2 && !conflicting ? clamp(score(selected))
        : Math.min(conflicting ? 0.82 : 0.86, score(selected))
    return {
      value: selected.match.value, confidence,
      raw: readings.map((entry) => `${entry.variant}=${entry.text || '∅'} (${Math.round(entry.confidence * 100)}%)`).join(' | ')
    }
  }

  async scan(
    frame: Buffer,
    context: { sourceId: string; sourceName: string; fingerprint: string; calibration: ScannerCalibration; species: Species[]; includeCrops?: boolean; debugSave?: boolean }
  ): Promise<PokeMMOScanResult> {
    const metadata = await sharp(frame).metadata()
    if (!metadata.width || !metadata.height) throw new Error('Captured PokeMMO frame has no usable dimensions')
    const cropBuffers = {} as Record<CropKey, Buffer>
    for (const key of ['species', 'gender', 'ivs', 'nature', 'alpha', 'ha'] as CropKey[]) {
      cropBuffers[key] = await sharp(frame).extract(cropRect(metadata.width, metadata.height, context.calibration.rois[key])).png().toBuffer()
    }

    const speciesOcr = await this.ocrSpecies(cropBuffers.species, context.species)
    const ivOcr = await this.ocrIvs(cropBuffers.ivs)
    const natureOcr = await this.ocrNature(cropBuffers.nature)
    const speciesMeta = context.species.find((entry) => entry.id === speciesOcr.value)
    const [genderStats, alphaStats, haStats] = await Promise.all([
      rgbStats(cropBuffers.gender), rgbStats(cropBuffers.alpha), rgbStats(cropBuffers.ha)
    ])
    const detectedGender = detectGenderFromRgb(genderStats, context.calibration.thresholds.genderColorRatio, speciesMeta?.gender.kind === 'genderless')
    const gender = speciesMeta?.gender.kind === 'ratio' && speciesMeta.gender.femaleEighths === 0
      ? { value: 'Male' as const, confidence: 0.99 }
      : speciesMeta?.gender.kind === 'ratio' && speciesMeta.gender.femaleEighths === 8
        ? { value: 'Female' as const, confidence: 0.99 }
        : detectedGender
    const alpha = detectAlphaFromRgb(alphaStats, context.calibration.thresholds.alphaColorRatio)
    const hiddenAbility = detectHaFromRgb(haStats, context.calibration.thresholds.haColorRatio)
    const result: PokeMMOScanResult = {
      id: randomUUID(), capturedAt: new Date().toISOString(), sourceId: context.sourceId, sourceName: context.sourceName,
      fingerprint: context.fingerprint,
      species: speciesOcr,
      gender: { ...gender, raw: `blue=${genderStats.blue.toFixed(4)};cyan=${genderStats.cyan.toFixed(4)};pink=${genderStats.pink.toFixed(4)};pixels=${Math.max(genderStats.cyanPixels ?? 0, genderStats.bluePixels ?? 0)}/${genderStats.pinkPixels ?? 0}` },
      ivs: Object.fromEntries(STATS.map((stat) => [stat, { value: ivOcr.values?.[stat] ?? null, confidence: ivOcr.confidences[stat], raw: ivOcr.raw }])) as PokeMMOScanResult['ivs'],
      nature: natureOcr,
      alpha: { ...alpha, raw: `red=${alphaStats.red.toFixed(4)}` },
      hiddenAbility: { ...hiddenAbility, raw: `gold=${(haStats.yellow ?? 0).toFixed(4)};diamond=${Math.max(haStats.cyan, haStats.blue).toFixed(4)};pixels=${haStats.yellowPixels ?? 0}/${Math.max(haStats.cyanPixels ?? 0, haStats.bluePixels ?? 0)}` },
      status: 'Needs Review', issues: ivOcr.error ? [ivOcr.error] : []
    }
    const validation = validateScanResult(result, context.species, context.calibration.thresholds)
    result.status = ivOcr.error ? 'Error' : validation.status
    result.issues = [...new Set([...(ivOcr.error ? [ivOcr.error] : []), ...validation.issues])]
    if (context.includeCrops) {
      result.previewDataUrl = asDataUrl(frame)
      result.crops = Object.fromEntries(Object.entries(cropBuffers).map(([key, value]) => [key, asDataUrl(value)])) as PokeMMOScanResult['crops']
    }
    if (context.debugSave) result.debugDirectory = await this.saveDebug(frame, cropBuffers, result)
    return result
  }

  private async saveDebug(frame: Buffer, crops: Record<CropKey, Buffer>, result: PokeMMOScanResult): Promise<string> {
    const folder = join(this.debugRoot, result.capturedAt.replace(/[:.]/g, '-'))
    await mkdir(folder, { recursive: true })
    await Promise.all([
      writeFile(join(folder, 'full-frame.png'), frame),
      ...Object.entries(crops).map(([key, value]) => writeFile(join(folder, `${key}.png`), value)),
      writeFile(join(folder, 'recognition.json'), `${JSON.stringify({ ...result, previewDataUrl: undefined, crops: undefined }, null, 2)}\n`)
    ])
    return folder
  }

  async dispose(): Promise<void> {
    await this.ocrQueue
    const worker = await this.workerPromise
    this.workerPromise = null
    if (worker) await worker.terminate()
  }
}

export async function normalizedCrop(image: Sharp, roi: NormalizedRoi): Promise<Buffer> {
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height) throw new Error('Image dimensions are unavailable')
  return image.clone().extract(cropRect(metadata.width, metadata.height, roi)).png().toBuffer()
}
