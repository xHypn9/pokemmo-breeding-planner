import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class SpriteProvider {
  constructor(private readonly cacheDirectory: string) { mkdirSync(cacheDirectory, { recursive: true }) }

  async get(speciesId: number): Promise<string | null> {
    const path = join(this.cacheDirectory, `${speciesId}.png`)
    try {
      const bytes = existsSync(path) ? readFileSync(path) : await this.download(speciesId, path)
      return `data:image/png;base64,${bytes.toString('base64')}`
    } catch { return null }
  }

  private async download(speciesId: number, path: string): Promise<Buffer> {
    const response = await fetch(`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${speciesId}.png`)
    if (!response.ok) throw new Error(`Sprite download failed: ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 512_000) throw new Error('Sprite exceeds cache size limit')
    writeFileSync(path, bytes)
    return bytes
  }
}
