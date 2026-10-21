import { describe, it, expect, vi } from 'vitest'

vi.mock('@janhq/core', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  fs: {},
}))

import {
  describeFitBudget,
  fitTargetFirstMiB,
  fitTargetsMiB,
  spillSlotPlan,
} from './preset'

describe('fitTargetFirstMiB', () => {
  it('defaults when blank or unreadable', () => {
    expect(fitTargetFirstMiB(undefined)).toBe(1024)
    expect(fitTargetFirstMiB('')).toBe(1024)
    expect(fitTargetFirstMiB('abc')).toBe(1024)
    expect(fitTargetFirstMiB('-5')).toBe(1024)
  })
  it('treats 0 as a real value', () => {
    expect(fitTargetFirstMiB('0')).toBe(0)
    expect(fitTargetFirstMiB('256,512')).toBe(256)
  })
  it('lets the slot plan see a 0 target instead of assuming 1 GiB', () => {
    // 14.5 GiB of weights on a 16 GiB card: room to spare with 0 kept free,
    // a near-spill with 1024.
    const w = 14.5 * 1024 * 1024 * 1024
    expect(spillSlotPlan(w, 16384, fitTargetFirstMiB('0'), 4096, 3)).toBeUndefined()
    expect(spillSlotPlan(w, 16384, fitTargetFirstMiB(''), 4096, 3)).toEqual({
      fitCtx: 8192,
    })
  })
})

describe('spillSlotPlan near-spill', () => {
  it('treats weights that leave under the KV slack as spilling', () => {
    const w = 14.2 * 1024 * 1024 * 1024
    expect(spillSlotPlan(w, 16384, 1024, 4096, 3)).toEqual({ fitCtx: 8192 })
    expect(spillSlotPlan(10 * 1024 ** 3, 16384, 1024, 4096, 3)).toBeUndefined()
  })
})

describe('fitTargetsMiB', () => {
  it('broadcasts a single value and reads a list per device', () => {
    expect(fitTargetsMiB('512', 2)).toEqual([512, 512])
    expect(fitTargetsMiB('512,256', 2)).toEqual([512, 256])
    expect(fitTargetsMiB('', 1)).toEqual([1024])
    expect(fitTargetsMiB('x,1', 2)).toEqual([1024, 1024])
  })
})

describe('describeFitBudget', () => {
  const gpu = {
    id: 'Vulkan0',
    name: 'AMD Radeon RX 9060 XT',
    mem: 16304,
    free: 14100,
  }
  it('says what is left for the model after the memory to keep free', () => {
    const [line] = describeFitBudget([gpu], true, '1024')
    expect(line).toContain('Vulkan0')
    expect(line).toContain('16304 MiB reported, 14100 MiB free now')
    expect(line).toContain('keeps 1024 MiB free')
    expect(line).toContain('up to 13076 MiB')
  })
  it('never reports a negative budget', () => {
    const [line] = describeFitBudget([{ ...gpu, free: 500 }], true, '1024')
    expect(line).toContain('up to 0 MiB')
  })
  it('notes when auto-fit is off and returns nothing without GPUs', () => {
    expect(describeFitBudget([gpu], false, '1024')[0]).toContain(
      'auto-fit is off'
    )
    expect(describeFitBudget([], true, '1024')).toEqual([])
  })
})
