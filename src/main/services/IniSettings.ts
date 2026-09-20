import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** JSON values preserve booleans and calibration objects inside a simple INI section. */
export class IniSettings {
  private values: Record<string, unknown>
  constructor(readonly path: string, defaults: Record<string, unknown> = {}) {
    this.values = { ...defaults }
    if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([a-zA-Z0-9_.-]+)\s*=(.*)$/)
      if (!match) continue
      try { this.values[match[1]!] = JSON.parse(match[2]!) } catch { /* Ignore malformed individual values. */ }
    }
    this.flush()
  }
  get(): Record<string, unknown> { return { ...this.values } }
  set(key: string, value: unknown): void {
    if (JSON.stringify(this.values[key]) === JSON.stringify(value)) return
    this.values[key] = value; this.flush()
  }
  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const contents = '; PokeMMO Breeding Planner preferences (JSON values)\n[settings]\n' + Object.entries(this.values)
      .filter(([key, value]) => /^[a-zA-Z0-9_.-]{1,80}$/.test(key) && value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n'
    writeFileSync(`${this.path}.tmp`, contents, 'utf8')
    renameSync(`${this.path}.tmp`, this.path)
  }
}
