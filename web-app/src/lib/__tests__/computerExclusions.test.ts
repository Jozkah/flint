import { describe, expect, it } from 'vitest'
import { regionFromDrag } from '../computerExclusions'

describe('regionFromDrag', () => {
  const shown = { width: 500, height: 250 }
  const natural = { width: 1000, height: 500 }

  it('scales a drag to desktop pixels whatever the drag direction', () => {
    const r = { x: 100, y: 50, width: 200, height: 100 }
    expect(regionFromDrag({ x: 50, y: 25 }, { x: 150, y: 75 }, shown, natural)).toEqual(r)
    expect(regionFromDrag({ x: 150, y: 75 }, { x: 50, y: 25 }, shown, natural)).toEqual(r)
  })

  it('clamps a drag that leaves the image', () => {
    expect(regionFromDrag({ x: -20, y: -20 }, { x: 600, y: 300 }, shown, natural)).toEqual({
      x: 0, y: 0, width: 1000, height: 500,
    })
  })
})
