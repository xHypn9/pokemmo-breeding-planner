import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BreedParentRow } from '../src/renderer/src/components/BreedParentRow'
import type { PlanNode, Species } from '../src/shared/types'

const species = [{ id: 570, name: 'Zorua' }, { id: 132, name: 'Ditto' }] as Species[]
const parent = (id: string, speciesId: number, inventoryId: number, gender: PlanNode['gender']): PlanNode => ({
  id, speciesId, inventoryId, gender, kind: 'inventory'
}) as PlanNode

describe('breed step parents', () => {
  it('shows the actual parent species, inventory ID and assigned item in tree order', () => {
    const html = renderToStaticMarkup(<>
      <BreedParentRow node={parent('inventory-279', 570, 279, 'Male')} item={{ type: 'None' }} species={species} position="A" />
      <BreedParentRow node={parent('inventory-20', 132, 20, 'Genderless')} item={{ type: 'Brace', stat: 'def' }} species={species} position="B" />
    </>)

    expect(html.indexOf('Zorua')).toBeLessThan(html.indexOf('Ditto'))
    expect(html).toContain('Male · #279')
    expect(html).toContain('Genderless · #20')
    expect(html).toContain('No item')
    expect(html).toContain('Brace → def')
  })

  it('identifies a generated parent without inventing an inventory number', () => {
    const html = renderToStaticMarkup(<BreedParentRow
      node={{ id: 'intermediate-1', kind: 'intermediate', speciesId: 570, gender: 'Female' } as PlanNode}
      item={{ type: 'Everstone', nature: 'Jolly' }} species={species} position="A"
    />)
    expect(html).toContain('Female · Planned')
    expect(html).toContain('Everstone → Jolly')
  })
})
