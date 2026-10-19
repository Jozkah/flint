import { beforeEach, describe, it, expect, vi } from 'vitest'

const warning = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { warning } }))
const openUrl = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ opener: () => ({ openUrl }) }),
}))

import { useBuildUpdate } from '../useBuildUpdate'

const latest = (tag: string) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: tag,
      html_url: `https://github.com/Jozkah/flint/releases/tag/${tag}`,
      draft: false,
      prerelease: false,
    }),
  })

describe('useBuildUpdate.run', () => {
  beforeEach(() => {
    warning.mockClear()
    openUrl.mockClear()
    useBuildUpdate.setState({ enabled: false, checkedAt: 0, notifiedFor: '', last: null })
    // VERSION is 'test' under vitest; pretend an older release is installed.
    vi.stubGlobal('VERSION', '0.9.0')
  })

  it('announces a version once, but a manual check always shows it', async () => {
    vi.stubGlobal('fetch', latest('v1.0.1'))
    await useBuildUpdate.getState().run()
    expect(warning).toHaveBeenCalledTimes(1)
    expect(useBuildUpdate.getState().notifiedFor).toBe('1.0.1')
    await useBuildUpdate.getState().run()
    expect(warning).toHaveBeenCalledTimes(1)
    await useBuildUpdate.getState().run({ manual: true })
    expect(warning).toHaveBeenCalledTimes(2)
  })

  it('opens the release page through the desktop opener', async () => {
    vi.stubGlobal('fetch', latest('v1.0.1'))
    await useBuildUpdate.getState().run()
    const opts = warning.mock.calls[0][1] as { action: { onClick: () => void } }
    opts.action.onClick()
    expect(openUrl).toHaveBeenCalledWith('https://github.com/Jozkah/flint/releases/tag/v1.0.1')
  })

  it('stays quiet when up to date, ahead, or unreachable', async () => {
    vi.stubGlobal('fetch', latest('v0.9.0'))
    expect((await useBuildUpdate.getState().run({ manual: true })).state).toBe('current')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }))
    const r = await useBuildUpdate.getState().run({ manual: true })
    expect(r.state).toBe('unknown')
    expect(useBuildUpdate.getState().checkedAt).toBeGreaterThan(0)
    expect(warning).not.toHaveBeenCalled()
  })
})
