import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Characterization of three stores' shape, captured before their create()
// literals were split into slices: every state key and action name, with the
// kind of each (a function or a value), must survive the split.
const shape = (state: object) =>
  Object.fromEntries(
    Object.entries(state)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, typeof v === 'function' ? 'action' : typeof v])
  )

describe('store keys', () => {
  it('useThreads', async () => {
    const { useThreads } = await import('../useThreads')
    expect(shape(useThreads.getState())).toMatchSnapshot()
  })

  it('useCoworkRun', async () => {
    const { useCoworkRun } = await import('../useCoworkRun')
    expect(shape(useCoworkRun.getState())).toMatchSnapshot()
  })

  it('useInterfaceSettings', async () => {
    const { useInterfaceSettings } = await import('../useInterfaceSettings')
    expect(shape(useInterfaceSettings.getState())).toMatchSnapshot()
  })
})
