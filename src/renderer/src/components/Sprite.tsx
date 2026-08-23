import { useEffect, useState } from 'react'

const cache = new Map<number, string | null>()

export function Sprite({ speciesId, size = 40 }: { speciesId: number | null; size?: number }) {
  const [source, setSource] = useState<string | null>(speciesId ? cache.get(speciesId) ?? null : null)
  useEffect(() => {
    let active = true
    if (!speciesId) { setSource(null); return }
    if (cache.has(speciesId)) { setSource(cache.get(speciesId) ?? null); return }
    void window.desktopApi.sprite.get(speciesId).then((data) => { cache.set(speciesId, data); if (active) setSource(data) })
    return () => { active = false }
  }, [speciesId])
  return source
    ? <img className="sprite" width={size} height={size} src={source} alt="" />
    : <span className="sprite-placeholder" style={{ width: size, height: size }}>?</span>
}
