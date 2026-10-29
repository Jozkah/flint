import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Characterization of the remote registries' method names, captured before
// they were split by domain. The merged registries must keep the same keys.
describe('remote registry keys', () => {
  it('action handlers', async () => {
    const { createActionHandlers } = await import('../actions')
    expect(Object.keys(createActionHandlers({} as never)).sort()).toMatchSnapshot()
  })

  it('app actions', async () => {
    const { appActions } = await import('../appActions')
    expect(Object.keys(appActions(() => undefined)).sort()).toMatchSnapshot()
  })

  it('app extras', async () => {
    const { appExtras } = await import('../appExtras')
    expect(Object.keys(appExtras).sort()).toMatchSnapshot()
  })

  it('app sources', async () => {
    const { appSources } = await import('../sources')
    expect(Object.keys(appSources).sort()).toMatchSnapshot()
  })
})
