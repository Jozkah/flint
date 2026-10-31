import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { refuseUnrunnable } from '@/lib/cowork/run/refuseUnrunnable'

const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key} ${JSON.stringify(opts)}` : key) as never

const model = (capabilities: string[]) =>
  ({ id: 'm1', capabilities }) as unknown as Model

const input = (over: Record<string, unknown> = {}) =>
  ({
    resolved: {
      choice: { provider: 'p1', id: 'm1' },
      model: model(['tools']),
      unavailable: null,
      save: false,
    },
    globalProvider: 'p0',
    access: 'review-only',
    effective: { destination: 'none' },
    t,
    onRefused: vi.fn(),
    ...over,
  }) as never as Parameters<typeof refuseUnrunnable>[0]

describe('refuseUnrunnable', () => {
  beforeEach(() => toastError.mockReset())

  it('lets a tool-capable model with plain access run', () => {
    const i = input()
    expect(refuseUnrunnable(i)).toBe(false)
    expect(toastError).not.toHaveBeenCalled()
    expect(i.onRefused).not.toHaveBeenCalled()
  })

  it('refuses without a model, naming an unavailable saved one', () => {
    const i = input({
      resolved: {
        choice: null,
        model: null,
        unavailable: { provider: 'p1', id: 'gone' },
        save: false,
      },
    })
    expect(refuseUnrunnable(i)).toBe(true)
    expect(toastError).toHaveBeenCalledWith(
      'common:sessionModelUnavailable {"model":"gone"}'
    )
    expect(i.onRefused).toHaveBeenCalledOnce()
  })

  it('refuses without a model and asks to pick one', () => {
    const i = input({
      resolved: { choice: null, model: null, unavailable: null, save: false },
    })
    expect(refuseUnrunnable(i)).toBe(true)
    expect(toastError).toHaveBeenCalledWith('common:selectModel')
  })

  it('refuses a toolless model with a sticky toast offering the override', () => {
    const i = input({
      resolved: {
        choice: { provider: 'p1', id: 'm1' },
        model: model([]),
        unavailable: null,
        save: false,
      },
    })
    expect(refuseUnrunnable(i)).toBe(true)
    const [text, opts] = toastError.mock.calls[0]
    expect(text).toBe('common:modelNoTools {"model":"m1"}')
    expect(opts.duration).toBe(Infinity)
    expect(opts.action.label).toBe('common:modelCapability.enableAlways')
    expect(i.onRefused).toHaveBeenCalledOnce()
  })

  it('refuses a managed-worktree session whose grant is not back', () => {
    const i = input({ access: 'managed-worktree' })
    expect(refuseUnrunnable(i)).toBe(true)
    expect(i.onRefused).toHaveBeenCalledOnce()
  })
})
