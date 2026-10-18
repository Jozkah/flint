import { describe, expect, it, vi } from 'vitest'
import { installToastDedupe } from '../toastDedupe'

type Fn = (message: unknown, data?: Record<string, unknown>) => unknown

function fakeToast() {
  const calls: Array<[string, unknown, Record<string, unknown> | undefined]> = []
  const make = (kind: string): Fn => vi.fn((m, d) => calls.push([kind, m, d]))
  const t = Object.assign(make('default'), {
    success: make('success'),
    error: make('error'),
    info: make('info'),
    warning: make('warning'),
    message: make('message'),
  })
  return { t, calls }
}

describe('installToastDedupe', () => {
  it('gives identical toasts one id, so they replace instead of stacking', () => {
    const { t, calls } = fakeToast()
    installToastDedupe(t)
    for (let i = 0; i < 6; i++) t.success('Added 0 prompts')
    const ids = calls.map(([, , d]) => d?.id)
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBeTruthy()
  })

  it('keeps distinct toasts distinct (message, description and kind)', () => {
    const { t, calls } = fakeToast()
    installToastDedupe(t)
    t.success('Saved')
    t.success('Saved', { description: 'a.txt' })
    t.success('Saved', { description: 'b.txt' })
    t.error('Saved')
    t.success('Other')
    expect(new Set(calls.map(([, , d]) => d?.id)).size).toBe(5)
  })

  it('leaves explicit ids, actions and non-string messages alone', () => {
    const { t, calls } = fakeToast()
    installToastDedupe(t)
    t.success('Deleted', { id: 'mine' })
    t.success('Deleted', { action: { label: 'Undo', onClick: () => {} } })
    t.info({ jsx: true })
    expect(calls[0][2]?.id).toBe('mine')
    expect(calls[1][2]?.id).toBeUndefined()
    expect(calls[2][2]?.id).toBeUndefined()
  })

  it('installs once', () => {
    const { t, calls } = fakeToast()
    installToastDedupe(t)
    installToastDedupe(t)
    t.success('x')
    expect(calls).toHaveLength(1)
  })
})
