import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import eng from '@tesseract.js-data/eng'
import { SPECIES } from '../src/data/species'
import {
  detectAlphaFromRgb, detectGenderFromRgb, detectHaFromRgb, RecognitionEngine
} from '../src/main/scanner/RecognitionEngine'
import { locateDepositBox, roisFromDetectedBox } from '../src/main/scanner/BoxLocator'
import {
  DEFAULT_SCANNER_CALIBRATION, fingerprintDistance, isPokeMMOWindowName, matchNature, matchSpecies, moveNormalizedRoi, parseIvs, resizeNormalizedRoi,
  scannerGenderCompatible, selectIvOcrConsensus, setNormalizedRoiProperty, validateScanResult
} from '../src/shared/scanner'

const privateScannerFixture = join(process.cwd(), 'tests', 'fixtures', 'pokemmo-butterfree-alpha-ha.png')
const hasPrivateScannerFixture = existsSync(privateScannerFixture)

describe('scanner parsers', () => {
  it('accepts only the real PokeMMO window as a scanner source', () => {
    expect(isPokeMMOWindowName('PokeMMO')).toBe(true)
    expect(isPokeMMOWindowName('Pok\u0435MMO')).toBe(true)
    expect(isPokeMMOWindowName('\u0420ok\u0435M\u041CO')).toBe(true)
    expect(isPokeMMOWindowName('\u0420\u043E\u043A\u0435\u041C\u041C\u041E')).toBe(true)
    expect(isPokeMMOWindowName('\u03A1\u03BF\u03BA\u03B5\u039C\u039C\u039F')).toBe(true)
    expect(isPokeMMOWindowName('PokeMMO - Account')).toBe(true)
    expect(isPokeMMOWindowName('PokeMMO Breeding Planner')).toBe(false)
    expect(isPokeMMOWindowName('Google Chrome')).toBe(false)
  })

  it('moves and resizes calibration areas while keeping them inside the captured window', () => {
    const roi = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }
    const moved = moveNormalizedRoi(roi, -0.1, 0.3)
    expect(moved.x).toBeCloseTo(0.3); expect(moved.y).toBeCloseTo(0.7)
    expect(moved.width).toBe(0.2); expect(moved.height).toBe(0.2)
    expect(moveNormalizedRoi(roi, 1, 1)).toEqual({ x: 0.8, y: 0.8, width: 0.2, height: 0.2 })
    const resizedNorthWest = resizeNormalizedRoi(roi, 'nw', -0.1, -0.2)
    expect(resizedNorthWest.x).toBeCloseTo(0.3); expect(resizedNorthWest.y).toBeCloseTo(0.2)
    expect(resizedNorthWest.width).toBeCloseTo(0.3); expect(resizedNorthWest.height).toBeCloseTo(0.4)
    expect(resizeNormalizedRoi(roi, 'se', 1, 1)).toEqual({ x: 0.4, y: 0.4, width: 0.6, height: 0.6 })
    expect(setNormalizedRoiProperty(roi, 'x', 0.95).x).toBe(0.8)
    expect(setNormalizedRoiProperty(roi, 'width', 0.9).width).toBe(0.6)
  })

  it('compares perceptual fingerprints with tolerance instead of exact hashes', () => {
    expect(fingerprintDistance('0001020f', '0001020f')).toBe(0)
    expect(fingerprintDistance('0001020f', '0102030e')).toBeCloseTo(1 / 15)
    expect(fingerprintDistance('', '0102')).toBe(Number.POSITIVE_INFINITY)
  })

  it.skipIf(!hasPrivateScannerFixture)('automatically locates the PC Deposit Box and derives the reference fields', async () => {
    const frame = readFileSync(privateScannerFixture)
    const detection = await locateDepositBox(frame)
    expect(detection).not.toBeNull()
    expect(detection!.box.x).toBeLessThan(0.01); expect(detection!.box.y).toBeLessThan(0.03)
    expect(detection!.box.width).toBeGreaterThan(0.98); expect(detection!.box.height).toBeGreaterThan(0.95)
    const rois = roisFromDetectedBox(detection!.box)
    expect(rois.species.x).toBeCloseTo(DEFAULT_SCANNER_CALIBRATION.rois.species.x, 3)
    expect(rois.ivs.y).toBeCloseTo(DEFAULT_SCANNER_CALIBRATION.rois.ivs.y, 3)
    expect(rois.species.width).toBeGreaterThan(0.26)
    expect(rois.gender).toEqual(rois.species)
    expect(rois.ha.width).toBeGreaterThan(0.26)
  })

  it('parses exactly six valid slash-separated IVs', () => {
    expect(parseIvs('31/31/14/25/15/2').values).toEqual({ hp: 31, atk: 31, def: 14, spAtk: 25, spDef: 15, speed: 2 })
  })

  it('uses multi-pass consensus to correct a 14 misread as 18 and flags only the disagreement', () => {
    const selected = selectIvOcrConsensus([
      { variant: 'threshold-90', text: '31/31/18/25/15/2', confidence: 0.94 },
      { variant: 'threshold-100', text: '31/31/14/25/15/2', confidence: 0.91 },
      { variant: 'threshold-110', text: '31/31/14/25/15/2', confidence: 0.88 }
    ])
    expect(selected.values).toEqual({ hp: 31, atk: 31, def: 14, spAtk: 25, spDef: 15, speed: 2 })
    expect(selected.confidences.hp).toBeGreaterThanOrEqual(0.9)
    expect(selected.confidences.def).toBeLessThan(0.9)
    expect(selected.raw).toContain('threshold-90=31/31/18/25/15/2')
  })

  it.each(['32/1/1/1/1/1', '-1/1/1/1/1/1', '1/2/3/4/5', '1/2/3/4/5/6/7', '31/O/1/1/1/1'])(
    'rejects impossible or unrecoverable IV text: %s', (raw) => expect(parseIvs(raw).values).toBeNull()
  )

  it('fuzzy-matches OCR text only against the bundled species and nature dictionaries', () => {
    expect(SPECIES.find((entry) => entry.id === matchSpecies('Lv. 70 Butterflee J', SPECIES).value)?.name).toBe('Butterfree')
    expect(matchNature('Na1ve [+Spe/-SpD]').value).toBe('Naive')
    expect(matchNature('Nature Naive [+Spe/-SpD]').value).toBe('Naive')
    expect(matchNature('NatureNa1ve [+Spe/-SpD]').value).toBe('Naive')
    expect(matchNature('Nature: Re1axed [+Def/-Spe]').value).toBe('Relaxed')
  })

  it('validates gender against species metadata', () => {
    const ditto = SPECIES.find((entry) => entry.name === 'Ditto')!
    expect(scannerGenderCompatible(ditto, 'Genderless')).toBe(true)
    expect(scannerGenderCompatible(ditto, 'Female')).toBe(false)
    expect(scannerGenderCompatible(SPECIES.find((entry) => entry.name === 'Nidoran M')!, 'Female')).toBe(false)
  })

  it.each(['Nidorina', 'Nidoqueen'])('allows non-breedable %s into inventory after scanner validation', (name) => {
    const meta = SPECIES.find((entry) => entry.name === name)!
    const field = <T,>(value: T) => ({ value, confidence: 1, raw: 'test' })
    const result = {
      id: `test-${name}`, capturedAt: new Date(0).toISOString(), sourceId: 'test', sourceName: 'test', fingerprint: name,
      species: field(meta.id), gender: field<'Female'>('Female'),
      ivs: { hp: field(31), atk: field(30), def: field(20), spAtk: field(31), spDef: field(19), speed: field(18) },
      nature: field<'Naughty'>('Naughty'), alpha: field(true), hiddenAbility: field(true), status: 'Verified' as const, issues: []
    }
    const validation = validateScanResult(result, SPECIES, DEFAULT_SCANNER_CALIBRATION.thresholds)
    expect(validation).toEqual({ status: 'Verified', issues: [] })
  })
})

describe('visual indicators', () => {
  it('detects positive and negative Alpha/HA color evidence', () => {
    expect(detectAlphaFromRgb({ red: 0.11, cyan: 0, blue: 0, pink: 0 }, 0.012).value).toBe(true)
    expect(detectAlphaFromRgb({ red: 0, cyan: 0, blue: 0, pink: 0 }, 0.012).value).toBe(false)
    expect(detectHaFromRgb({ red: 0, cyan: 0.022, blue: 0.01, pink: 0, yellow: 0.02 }, 0.006).value).toBe(true)
    expect(detectHaFromRgb({ red: 0, cyan: 0, blue: 0, pink: 0 }, 0.006).value).toBe(false)
  })

  it('requires both the golden ability text and cyan diamond for HA', () => {
    expect(detectHaFromRgb({ red: 0, cyan: 0.02, blue: 0.01, pink: 0, yellow: 0 }, 0.006).value).toBeNull()
    expect(detectHaFromRgb({ red: 0, cyan: 0, blue: 0, pink: 0, yellow: 0.02 }, 0.006).value).toBeNull()
    expect(detectHaFromRgb({
      red: 0, cyan: 0.003, blue: 0.002, pink: 0, yellow: 0.01,
      cyanPixels: 35, bluePixels: 23, yellowPixels: 80, pixelCount: 10_000
    }, 0.006).value).toBe(true)
  })

  it('detects male, female and dataset-backed genderless states', () => {
    expect(detectGenderFromRgb({ red: 0, cyan: 0.05, blue: 0.06, pink: 0 }, 0.008, false).value).toBe('Male')
    expect(detectGenderFromRgb({ red: 0, cyan: 0, blue: 0, pink: 0.05 }, 0.008, false).value).toBe('Female')
    expect(detectGenderFromRgb({ red: 0, cyan: 0, blue: 0, pink: 0 }, 0.008, true).value).toBe('Genderless')
  })

  it('keeps weak but dominant gender color as an explicit review suggestion', () => {
    const reading = detectGenderFromRgb({ red: 0, cyan: 0.003, blue: 0.004, pink: 0.0001 }, 0.008, false)
    expect(reading.value).toBe('Male')
    expect(reading.confidence).toBeGreaterThanOrEqual(0.7)
    expect(reading.confidence).toBeLessThan(0.9)
  })
})

describe('real PokeMMO screenshot milestone', () => {
  const engine = new RecognitionEngine(eng, join(process.cwd(), 'development-data', 'scanner-test-debug'))
  afterAll(async () => engine.dispose())

  it.skipIf(!hasPrivateScannerFixture)('recognizes full information rows and validates HA from gold text plus diamond', async () => {
    const frame = readFileSync(privateScannerFixture)
    const detection = await locateDepositBox(frame)
    if (!detection) throw new Error('Expected automatic PC Deposit Box detection')
    const result = await engine.scan(frame, {
      sourceId: 'fixture', sourceName: 'PokeMMO fixture', fingerprint: 'fixture-butterfree',
      calibration: { ...DEFAULT_SCANNER_CALIBRATION, rois: roisFromDetectedBox(detection.box) }, species: SPECIES
    })
    expect(SPECIES.find((entry) => entry.id === result.species.value)?.name).toBe('Butterfree')
    expect(result.gender.value).toBe('Male')
    expect(Object.fromEntries(Object.entries(result.ivs).map(([stat, field]) => [stat, field.value]))).toEqual({ hp: 31, atk: 31, def: 14, spAtk: 25, spDef: 15, speed: 2 })
    expect(result.nature.value).toBe('Naive')
    expect(result.alpha.value).toBe(true)
    expect(result.hiddenAbility.value).toBe(true)
    expect(result.status).toBe('Verified')
    expect(result.hiddenAbility.raw).toContain('gold=')
    expect(result.hiddenAbility.raw).toContain('diamond=')
  }, 20_000)
})
