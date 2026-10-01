import { describe, expect, it } from 'vitest'
import { fitToViewport } from '../ArchiveContextMenu'

describe('fitToViewport', () => {
  it('keeps a menu that fits where it opened', () => {
    expect(fitToViewport(100, 100, 160, 80, 800, 600)).toEqual({ left: 100, top: 100 })
  })
  it('flips left of the pointer at the right edge', () => {
    expect(fitToViewport(780, 100, 160, 80, 800, 600)).toEqual({ left: 620, top: 100 })
  })
  it('flips above the pointer at the bottom edge', () => {
    expect(fitToViewport(100, 590, 160, 80, 800, 600)).toEqual({ left: 100, top: 510 })
  })
  it('never leaves the window', () => {
    expect(fitToViewport(2, 2, 900, 700, 800, 600)).toEqual({ left: 8, top: 8 })
  })
})
