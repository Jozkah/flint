import { describe, expect, it } from 'vitest'
import { containRect, hasPaint, invertOverlay, maskSize, overlayToMask, paintedBounds, rectBetween, toMaskPoint, toPictureRect } from '../mask'

describe('where the picture sits in its frame', () => {
  it('letterboxes a wide picture in a square frame', () => {
    expect(containRect({ width: 400, height: 400 }, { width: 2000, height: 1000 })).toEqual({ x: 0, y: 100, width: 400, height: 200 })
  })
  it('pillarboxes a tall picture', () => {
    expect(containRect({ width: 400, height: 200 }, { width: 100, height: 200 })).toEqual({ x: 150, y: 0, width: 100, height: 200 })
  })
  it('is empty before anything is measured', () => {
    expect(containRect({ width: 0, height: 0 }, { width: 10, height: 10 }).width).toBe(0)
  })
})

describe('the mask', () => {
  it('keeps a small picture at its size and shrinks a big one to the limit', () => {
    expect(maskSize({ width: 1024, height: 768 })).toEqual({ width: 1024, height: 768 })
    expect(maskSize({ width: 4096, height: 2048 })).toEqual({ width: 1024, height: 512 })
  })

  it('maps a pointer on screen to mask pixels', () => {
    const shown = { left: 100, top: 50, width: 200, height: 100 }
    expect(toMaskPoint({ x: 200, y: 100 }, shown, { width: 1000, height: 500 })).toEqual({ x: 500, y: 250 })
  })

  it('makes a rectangle from corners dragged in any direction', () => {
    expect(rectBetween({ x: 30, y: 40 }, { x: 10, y: 5 })).toEqual({ x: 10, y: 5, width: 20, height: 35 })
  })

  it('turns paint into opaque white and the rest into opaque black', () => {
    const overlay = new Uint8ClampedArray([139, 92, 246, 255, 0, 0, 0, 0])
    const { pixels, painted } = overlayToMask(overlay)
    expect(painted).toBe(true)
    expect(Array.from(pixels)).toEqual([255, 255, 255, 255, 0, 0, 0, 255])
  })

  it('says when nothing was painted', () => {
    expect(overlayToMask(new Uint8ClampedArray(8)).painted).toBe(false)
    expect(hasPaint(new Uint8ClampedArray(8))).toBe(false)
    expect(hasPaint(new Uint8ClampedArray([0, 0, 0, 1]))).toBe(true)
  })

  it('swaps painted and unpainted when inverted', () => {
    const overlay = new Uint8ClampedArray([1, 2, 3, 255, 0, 0, 0, 0])
    expect(Array.from(invertOverlay(overlay, [9, 8, 7, 255]))).toEqual([0, 0, 0, 0, 9, 8, 7, 255])
  })
})

describe('the box around a selection', () => {
  it('finds the painted pixels and nothing else', () => {
    const w = 6
    const h = 4
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (const [x, y] of [[2, 1], [4, 2]]) rgba[(y * w + x) * 4 + 3] = 255
    expect(paintedBounds(rgba, w, h)).toEqual({ x: 2, y: 1, width: 3, height: 2 })
    expect(paintedBounds(new Uint8ClampedArray(w * h * 4), w, h)).toBeNull()
  })

  it('scales the box to the picture, growing outward and staying inside it', () => {
    const mask = { width: 1024, height: 512 }
    const picture = { width: 4096, height: 2048 }
    expect(toPictureRect({ x: 10, y: 5, width: 20, height: 10 }, mask, picture)).toEqual({ x: 40, y: 20, width: 80, height: 40 })
    // A box at the edge never reaches past the picture.
    expect(toPictureRect({ x: 1000, y: 500, width: 24, height: 12 }, mask, picture)).toEqual({ x: 4000, y: 2000, width: 96, height: 48 })
    // Uneven scales round outward, so painted pixels are never cut off.
    expect(toPictureRect({ x: 1, y: 1, width: 1, height: 1 }, { width: 3, height: 3 }, { width: 10, height: 10 })).toEqual({ x: 3, y: 3, width: 4, height: 4 })
  })
})
