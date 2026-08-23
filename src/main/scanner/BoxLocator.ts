import sharp from 'sharp'
import { DEFAULT_SCANNER_CALIBRATION } from '../../shared/scanner'
import type { NormalizedRoi, ScannerCalibration, ScannerRoiKey } from '../../shared/types'

const BOX_ASPECT_RATIO = 1.625
const REFERENCE_FRAME = { width: 994, height: 623 }
const REFERENCE_BOX = { x: 3, y: 7, width: 986, height: 607 }

interface RowBand { y: number; x: number; width: number; density: number; luma: number }
interface BandGroup { rows: RowBand[] }

export interface DepositBoxDetection {
  box: NormalizedRoi
  confidence: number
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))

function titleBandForRow(data: Buffer, width: number, channels: number, y: number): RowBand | null {
  const minimumWidth = Math.floor(width * 0.18); const maximumGap = Math.max(4, Math.floor(width * 0.005))
  let best: RowBand | null = null; let start = -1; let lastGood = -1; let good = 0; let lumaTotal = 0
  const finish = () => {
    if (start < 0 || lastGood < start) return
    const bandWidth = lastGood - start + 1; const density = good / bandWidth; const luma = good ? lumaTotal / good : 0
    if (bandWidth >= minimumWidth && density >= 0.88 && luma >= 100 && (!best || bandWidth * density > best.width * best.density)) {
      best = { y, x: start, width: bandWidth, density, luma }
    }
    start = -1; lastGood = -1; good = 0; lumaTotal = 0
  }
  for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * channels
    const red = data[offset] ?? 0; const green = data[offset + 1] ?? 0; const blue = data[offset + 2] ?? 0
    const luma = (red + green + blue) / 3
    const titlePixel = Math.max(red, green, blue) - Math.min(red, green, blue) <= 32 && luma >= 45 && luma <= 190
    if (titlePixel) {
      if (start < 0) start = x
      lastGood = x; good += 1; lumaTotal += luma
    } else if (start >= 0 && x - lastGood > maximumGap) finish()
  }
  finish()
  return best
}

export async function locateDepositBox(frame: Buffer): Promise<DepositBoxDetection | null> {
  const { data, info } = await sharp(frame).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const rows: RowBand[] = []
  for (let y = 0; y < info.height; y += 1) {
    const band = titleBandForRow(data, info.width, info.channels, y)
    if (band) rows.push(band)
  }
  const groups: BandGroup[] = []
  for (const row of rows) {
    const current = groups.at(-1); const previous = current?.rows.at(-1)
    if (current && previous && row.y - previous.y <= 2 && Math.abs(row.x - previous.x) <= 5 && Math.abs(row.width - previous.width) <= 8) current.rows.push(row)
    else groups.push({ rows: [row] })
  }
  const candidates = groups.flatMap((group) => {
    if (group.rows.length < 4) return []
    const x = Math.round(group.rows.reduce((sum, row) => sum + row.x, 0) / group.rows.length)
    const width = Math.round(group.rows.reduce((sum, row) => sum + row.width, 0) / group.rows.length)
    const y = group.rows[0]!.y; const height = Math.round(width / BOX_ASPECT_RATIO)
    if (height < info.height * 0.2 || y + height > info.height + 4) return []
    const density = group.rows.reduce((sum, row) => sum + row.density, 0) / group.rows.length
    const luma = group.rows.reduce((sum, row) => sum + row.luma, 0) / group.rows.length
    const confidence = clamp(0.45 + (density - 0.88) * 1.7 + (luma - 100) / 180, 0, 0.99)
    const score = confidence * 100 + width / info.width * 20
    return [{ x, y, width, height: Math.min(height, info.height - y), confidence, score }]
  }).sort((left, right) => right.score - left.score)
  const best = candidates[0]
  if (!best) return null
  return { box: { x: best.x / info.width, y: best.y / info.height, width: best.width / info.width, height: best.height / info.height }, confidence: best.confidence }
}

export function roisFromDetectedBox(box: NormalizedRoi): ScannerCalibration['rois'] {
  return Object.fromEntries((Object.keys(DEFAULT_SCANNER_CALIBRATION.rois) as ScannerRoiKey[]).map((key) => {
    const reference = DEFAULT_SCANNER_CALIBRATION.rois[key]
    const local = {
      x: (reference.x * REFERENCE_FRAME.width - REFERENCE_BOX.x) / REFERENCE_BOX.width,
      y: (reference.y * REFERENCE_FRAME.height - REFERENCE_BOX.y) / REFERENCE_BOX.height,
      width: reference.width * REFERENCE_FRAME.width / REFERENCE_BOX.width,
      height: reference.height * REFERENCE_FRAME.height / REFERENCE_BOX.height
    }
    return [key, {
      x: clamp(box.x + local.x * box.width, 0, 1), y: clamp(box.y + local.y * box.height, 0, 1),
      width: clamp(local.width * box.width, 0.001, 1), height: clamp(local.height * box.height, 0.001, 1)
    }]
  })) as ScannerCalibration['rois']
}
