import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { IniSettings } from '../src/main/services/IniSettings'

it('restores scanner preferences and calibration from settings.ini after reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pbp-settings-'))
  try {
    const path = join(directory, 'settings.ini')
    const settings = new IniSettings(path, { 'scanner.hotkey': 'F2' })
    settings.set('scanner.hotkeyEnabled', true)
    settings.set('scanner.boxId', '7')
    settings.set('scanner.calibration', { autoDetectBox: false, rois: { x: 0.12 } })
    expect(readFileSync(path, 'utf8')).toContain('[settings]')
    const restored = new IniSettings(path, { 'scanner.hotkeyEnabled': false })
    expect(restored.get()).toEqual(settings.get())
    restored.set('scanner.hotkeyEnabled', false)
    expect(new IniSettings(path).get()['scanner.hotkeyEnabled']).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
