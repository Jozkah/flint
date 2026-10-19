import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  answerBypassConfirm,
  confirmBypass,
  resetBypassConfirm,
  useBypassConfirm,
} from '../bypassConfirm'

describe('confirmBypass', () => {
  beforeEach(() => resetBypassConfirm())

  it('never uses the native window.confirm', async () => {
    const native = vi.spyOn(window, 'confirm')
    const p = confirmBypass('sure?')
    expect(useBypassConfirm.getState().request?.message).toBe('sure?')
    answerBypassConfirm(true)
    await p
    expect(native).not.toHaveBeenCalled()
    native.mockRestore()
  })

  it('asks once, then remembers a yes for the app run', async () => {
    const first = confirmBypass('sure?')
    answerBypassConfirm(true)
    expect(await first).toBe(true)
    expect(await confirmBypass('sure?')).toBe(true)
    expect(useBypassConfirm.getState().request).toBeNull()
  })

  it('asks again after a no', async () => {
    const first = confirmBypass('sure?')
    answerBypassConfirm(false)
    expect(await first).toBe(false)
    const second = confirmBypass('sure?')
    expect(useBypassConfirm.getState().request).not.toBeNull()
    answerBypassConfirm(false)
    expect(await second).toBe(false)
  })
})
