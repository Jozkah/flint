import { describe, it, expect, vi, beforeEach } from 'vitest'
import { confirmBypass, resetBypassConfirm } from '../bypassConfirm'

describe('confirmBypass', () => {
  beforeEach(() => resetBypassConfirm())

  it('asks once, then remembers a yes for the app run', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    expect(confirmBypass('sure?')).toBe(true)
    expect(confirmBypass('sure?')).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('asks again after a no', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    expect(confirmBypass('sure?')).toBe(false)
    expect(confirmBypass('sure?')).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})
