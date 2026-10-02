import { beforeEach, describe, expect, it, vi } from 'vitest'

type Options = { action: { onClick: () => void }; cancel: { onClick: () => void }; onDismiss: () => void; onAutoClose: () => void }
const shown: Options[] = []
const dismissed: Array<string | number> = []

vi.mock('sonner', () => ({
  toast: Object.assign(
    vi.fn((_title: string, options: Options) => {
      shown.push(options)
      return shown.length
    }),
    { dismiss: vi.fn((id: string | number) => dismissed.push(id)) }
  ),
}))

import { askToSwitchModel } from '../jevModelPrompt'

const ask = (signal?: AbortSignal) => askToSwitchModel({ currentLabel: 'Gemma', targetLabel: 'Sonnet', signal })

beforeEach(() => {
  shown.length = 0
  dismissed.length = 0
})

describe('askToSwitchModel', () => {
  it('switches only when the action is pressed', async () => {
    const answer = ask()
    shown[0].action.onClick()
    expect(await answer).toBe(true)
    expect(dismissed).toEqual([1])
  })

  it('keeps the current model on Keep, a dismissal and the timeout', async () => {
    for (const press of ['cancel', 'dismiss', 'timeout'] as const) {
      shown.length = 0
      const answer = ask()
      const o = shown[0]
      if (press === 'cancel') o.cancel.onClick()
      if (press === 'dismiss') o.onDismiss()
      if (press === 'timeout') o.onAutoClose()
      expect(await answer).toBe(false)
    }
  })

  it('keeps the current model when the turn is stopped, and ignores a later press', async () => {
    const stop = new AbortController()
    const answer = ask(stop.signal)
    stop.abort()
    expect(await answer).toBe(false)
    shown[0].action.onClick()
    expect(await answer).toBe(false)
    const already = new AbortController()
    already.abort()
    expect(await ask(already.signal)).toBe(false)
  })
})
