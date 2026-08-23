import { desktopCapturer } from 'electron'
import sharp from 'sharp'
import type {
  PokeMMOScanResult, ScannerCalibration, ScannerFingerprint, ScannerPreview, ScannerScanRequest, ScannerSource, Species
} from '../../shared/types'
import { isPokeMMOWindowName } from '../../shared/scanner'
import { locateDepositBox, roisFromDetectedBox } from '../scanner/BoxLocator'
import { normalizedCrop, RecognitionEngine } from '../scanner/RecognitionEngine'

interface CapturedSource { id: string; name: string; buffer: Buffer }

export class ScannerService {
  constructor(private readonly recognition: RecognitionEngine, private readonly species: Species[]) {}

  async sources(): Promise<ScannerSource[]> {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false })
    return sources.filter((source) => !source.thumbnail.isEmpty() && isPokeMMOWindowName(source.name)).map((source) => ({
      id: source.id, name: source.name, displayId: source.display_id, thumbnailDataUrl: source.thumbnail.resize({ width: 160 }).toDataURL()
    })).sort((left, right) => left.name.localeCompare(right.name))
  }

  private async capture(sourceId: string): Promise<CapturedSource> {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 2560, height: 1600 }, fetchWindowIcons: false })
    const pokeMmoSources = sources.filter((entry) => isPokeMMOWindowName(entry.name))
    // Electron source IDs can change after a client restart or between discovery and capture.
    const source = pokeMmoSources.find((entry) => entry.id === sourceId) ?? pokeMmoSources.find((entry) => !entry.thumbnail.isEmpty())
    if (!source) throw new Error('PokeMMO was not found. Open the game and keep its window visible.')
    if (source.thumbnail.isEmpty()) throw new Error('PokeMMO produced an empty frame. Make sure it is visible and not minimized.')
    return { id: source.id, name: source.name, buffer: source.thumbnail.toPNG() }
  }

  async preview(sourceId: string): Promise<ScannerPreview> {
    const source = await this.capture(sourceId)
    const metadata = await sharp(source.buffer).metadata()
    const detection = await locateDepositBox(source.buffer)
    return {
      sourceId: source.id, sourceName: source.name, width: metadata.width ?? 0, height: metadata.height ?? 0,
      dataUrl: `data:image/png;base64,${source.buffer.toString('base64')}`,
      detectedBox: detection?.box, suggestedRois: detection ? roisFromDetectedBox(detection.box) : undefined,
      detectionConfidence: detection?.confidence
    }
  }

  private async effectiveCalibration(buffer: Buffer, calibration: ScannerCalibration): Promise<ScannerCalibration> {
    if (calibration.autoDetectBox === false) return calibration
    const detection = await locateDepositBox(buffer)
    if (!detection) throw new Error('PC Deposit Box was not detected. Open the Box window in PokeMMO and keep it visible.')
    return { ...calibration, rois: roisFromDetectedBox(detection.box) }
  }

  private async fingerprintValue(buffer: Buffer, calibration: ScannerCalibration): Promise<string> {
    const crop = await normalizedCrop(sharp(buffer), calibration.rois.fingerprint)
    const pixels = await sharp(crop).resize(24, 8, { fit: 'fill' }).grayscale().blur(0.6).raw().toBuffer()
    return Buffer.from(pixels.map((value) => Math.min(15, Math.round(value / 17)))).toString('hex')
  }

  async fingerprint(sourceId: string, calibration: ScannerCalibration): Promise<ScannerFingerprint> {
    const source = await this.capture(sourceId)
    const effective = await this.effectiveCalibration(source.buffer, calibration)
    return { value: await this.fingerprintValue(source.buffer, effective), sourceName: source.name }
  }

  async scanCurrent(request: ScannerScanRequest): Promise<PokeMMOScanResult> {
    const source = await this.capture(request.sourceId)
    const effective = await this.effectiveCalibration(source.buffer, request.calibration)
    const fingerprint = await this.fingerprintValue(source.buffer, effective)
    return this.recognition.scan(source.buffer, {
      sourceId: source.id, sourceName: source.name, fingerprint, calibration: effective, species: this.species,
      includeCrops: request.includeCrops, debugSave: request.debugSave
    })
  }

  async scanImageForSmokeTest(buffer: Buffer, calibration: ScannerCalibration): Promise<PokeMMOScanResult> {
    const effective = await this.effectiveCalibration(buffer, calibration)
    const fingerprint = await this.fingerprintValue(buffer, effective)
    return this.recognition.scan(buffer, {
      sourceId: 'packaged-smoke-test', sourceName: 'Packaged scanner smoke fixture', fingerprint,
      calibration: effective, species: this.species, includeCrops: false, debugSave: false
    })
  }

  dispose(): Promise<void> { return this.recognition.dispose() }
}
