import type { HeldItem, PlanNode, Species } from '../../../shared/types'
import { Sprite } from './Sprite'

function itemLabel(item: HeldItem): string {
  if (item.type === 'Brace') return `Brace → ${item.stat}`
  if (item.type === 'Everstone') return `Everstone → ${item.nature}`
  return 'No item'
}

export function BreedParentRow({ node, item, species, position }: {
  node: PlanNode | undefined; item: HeldItem; species: Species[]; position: 'A' | 'B'
}) {
  const name = node?.kind === 'missing'
    ? node.missing?.id.toUpperCase() ?? 'Missing breeder'
    : species.find((entry) => entry.id === node?.speciesId)?.name ?? 'Unknown Pokémon'
  const inventoryId = node?.inventoryId ?? node?.producedInventoryId

  return <div className="breed-parent-row" role="group" aria-label={`Parent ${position}`}>
    <Sprite speciesId={node?.speciesId ?? null} size={36} />
    <div className="breed-parent-info">
      <strong>{name}</strong>
      <small>{node?.gender ?? 'Unknown'}{inventoryId ? ` · #${inventoryId}` : node?.kind === 'missing' ? ' · To obtain' : ' · Planned'}</small>
      <span>{itemLabel(item)}</span>
    </div>
  </div>
}
