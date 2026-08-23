import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Species } from '../src/shared/types'

const MAX_NATIONAL_DEX = 649
const API = 'https://pokeapi.co/api/v2'
const OUTPUT = resolve('src/data/species.generated.json')

interface ApiSpecies {
  id: number
  name: string
  gender_rate: number
  is_baby: boolean
  egg_groups: Array<{ name: string }>
  evolution_chain: { url: string }
}

interface ChainNode {
  species: { name: string; url: string }
  evolves_to: ChainNode[]
}

const title = (slug: string) => slug.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
const idFromUrl = (url: string) => Number(url.match(/\/(\d+)\/?$/)?.[1])

async function fetchJson<T>(url: string, attempt = 1): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': 'PokeMMO-Breeding-Planner-Dataset/1.0' } })
  if (!response.ok) {
    if (attempt < 4 && response.status >= 429) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 750))
      return fetchJson<T>(url, attempt + 1)
    }
    throw new Error(`PokéAPI ${response.status} for ${url}`)
  }
  return response.json() as Promise<T>
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await fn(items[index] as T)
    }
  }))
  return output
}

function pathTo(node: ChainNode, targetId: number, path: number[] = []): number[] | null {
  const id = idFromUrl(node.species.url)
  const next = [...path, id]
  if (id === targetId) return next
  for (const child of node.evolves_to) {
    const found = pathTo(child, targetId, next)
    if (found) return found
  }
  return null
}

async function run(): Promise<void> {
  const ids = Array.from({ length: MAX_NATIONAL_DEX }, (_, index) => index + 1)
  process.stdout.write(`Downloading ${ids.length} species from PokéAPI...\n`)
  const raw = await mapLimit(ids, 20, (id) => fetchJson<ApiSpecies>(`${API}/pokemon-species/${id}`))
  const chainUrls = [...new Set(raw.map((entry) => entry.evolution_chain.url))]
  process.stdout.write(`Downloading ${chainUrls.length} evolution chains...\n`)
  const chains = await mapLimit(chainUrls, 20, async (url) => [url, await fetchJson<{ chain: ChainNode }>(url)] as const)
  const chainMap = new Map(chains)
  const rawMap = new Map(raw.map((entry) => [entry.id, entry]))

  const dataset: Species[] = raw.map((entry) => {
    const chainId = idFromUrl(entry.evolution_chain.url)
    const chain = chainMap.get(entry.evolution_chain.url)?.chain
    const path = chain ? pathTo(chain, entry.id) ?? [entry.id] : [entry.id]
    const hatchSpeciesId = path.find((id) => {
      const candidate = rawMap.get(id)
      return candidate && !candidate.egg_groups.some((group) => group.name === 'no-eggs')
    }) ?? entry.id
    const eggGroups = entry.egg_groups.map((group) => group.name)
    return {
      id: entry.id,
      name: title(entry.name),
      slug: entry.name,
      eggGroups,
      gender: entry.gender_rate < 0 ? { kind: 'genderless' as const } : { kind: 'ratio' as const, femaleEighths: entry.gender_rate },
      breedable: !eggGroups.includes('no-eggs'),
      isDitto: entry.id === 132,
      evolutionChainId: chainId,
      hatchSpeciesId,
      spriteId: entry.id,
      special: entry.is_baby ? ['baby'] : undefined
    }
  })

  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), source: 'https://pokeapi.co', maxNationalDex: MAX_NATIONAL_DEX, species: dataset }, null, 2)}\n`)
  process.stdout.write(`Wrote ${dataset.length} offline species to ${OUTPUT}\n`)
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
