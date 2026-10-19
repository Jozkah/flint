import { describe, it, expect } from 'vitest'
import { glideBox } from '../useSidebarGlide'

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height })

describe('glideBox', () => {
  it('keeps measured pixels when the shell is not zoomed', () => {
    const g = glideBox(box(0, 0, 250, 600), 250, box(12, 187, 216, 32), { left: 0, top: 10 })
    expect(g).toEqual({ x: 12, y: 197, width: 216, height: 32 })
  })

  it('divides out the interface zoom (20px font = 1.25)', () => {
    // The nav lays out at 250 and measures 312.5; the row lays out 216x32.
    const g = glideBox(box(0, 0, 312.5, 750), 250, box(15, 234, 270, 40), { left: 0, top: 0 })
    expect(g.x).toBeCloseTo(12)
    expect(g.y).toBeCloseTo(187.2)
    expect(g.width).toBeCloseTo(216)
    expect(g.height).toBeCloseTo(32)
  })

  it('falls back to no scale when the nav has no layout width', () => {
    const g = glideBox(box(0, 0, 100, 100), 0, box(5, 5, 50, 20), { left: 0, top: 0 })
    expect(g).toEqual({ x: 5, y: 5, width: 50, height: 20 })
  })
})
