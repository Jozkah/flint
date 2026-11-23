import { describe, it, expect, beforeEach } from 'vitest'
import { useAppState } from '@/hooks/useAppState'
import { withStudioStop } from '../toolStopControl'

const cancelOf = (id: string) => useAppState.getState().cancelToolCalls?.[id]

describe('withStudioStop', () => {
  beforeEach(() => {
    useAppState.setState({ cancelToolCalls: {} })
  })

  it('registers a cancel for the thread while a Studio call runs, then clears it', async () => {
    const cancel = () => {}
    let release: (v: string) => void = () => {}
    const pending = withStudioStop(
      't1',
      'studio_generate_image',
      cancel,
      () => new Promise<string>((r) => (release = r))
    )
    expect(cancelOf('t1')).toBe(cancel)
    release('done')
    await expect(pending).resolves.toBe('done')
    expect(cancelOf('t1')).toBeUndefined()
  })

  it('clears it when the call throws', async () => {
    await expect(
      withStudioStop('t1', 'studio_generate_image', () => {}, async () => {
        throw new Error('engine failed')
      })
    ).rejects.toThrow('engine failed')
    expect(cancelOf('t1')).toBeUndefined()
  })

  it('leaves other tools alone', async () => {
    let seen: unknown = 'unset'
    await withStudioStop('t1', 'read', () => {}, async () => {
      seen = cancelOf('t1')
    })
    expect(seen).toBeUndefined()
  })
})
