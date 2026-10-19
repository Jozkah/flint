import { describe, expect, it, vi } from 'vitest'
import {
  checkForNewerBuild,
  compareVersions,
  fetchLatestStable,
  pickStable,
  releaseUrl,
} from '../buildUpdate'

const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/Jozkah/flint/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  ...extra,
})
const reply = (body: unknown, ok = true, status = 200) =>
  vi.fn().mockResolvedValue({ ok, status, json: async () => body }) as unknown as typeof fetch

describe('compareVersions', () => {
  it('orders numerically with a v prefix', () => {
    expect(compareVersions('0.9.0', 'v1.0.1')).toBe(-1)
    expect(compareVersions('v1.0.1', '1.0.1')).toBe(0)
    expect(compareVersions('1.0.2', '1.0.1')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
  })
  it('sorts a pre-release below its release', () => {
    expect(compareVersions('1.0.1-nightly.20261019', '1.0.1')).toBe(-1)
    expect(compareVersions('1.0.2-nightly.1', '1.0.1')).toBe(1)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
  })
  it('is null for unreadable versions', () => {
    expect(compareVersions('test', '1.0.0')).toBeNull()
  })
})

describe('pickStable', () => {
  it('ignores prereleases, drafts and nightlies even when first in a list', () => {
    const list = [
      rel('nightly-20261019', { prerelease: true }),
      rel('v1.0.5-nightly.3'),
      rel('v1.0.4', { draft: true }),
      rel('v1.0.3', { prerelease: true }),
      rel('v1.0.1'),
      rel('v1.0.0'),
    ]
    expect(pickStable(list)).toEqual({ version: '1.0.1', url: 'https://github.com/Jozkah/flint/releases/tag/v1.0.1' })
  })
  it('rejects a lone nightly or an odd payload', () => {
    expect(pickStable(rel('nightly-1', { prerelease: true }))).toBeNull()
    expect(pickStable({ message: 'Not Found' })).toBeNull()
    expect(pickStable(null)).toBeNull()
  })
  it('falls back to the tag page when html_url is missing or foreign', () => {
    expect(pickStable(rel('v1.0.1', { html_url: 'https://evil.example/x' }))?.url).toBe(releaseUrl('1.0.1'))
  })
})

describe('fetchLatestStable', () => {
  it('asks the latest-release endpoint', async () => {
    const f = reply(rel('v1.0.1'))
    expect((await fetchLatestStable(f))?.version).toBe('1.0.1')
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://api.github.com/repos/Jozkah/flint/releases/latest'
    )
  })
  it('is null for 404, rate limit and offline', async () => {
    expect(await fetchLatestStable(reply({}, false, 404))).toBeNull()
    expect(await fetchLatestStable(reply({}, false, 403))).toBeNull()
    expect(await fetchLatestStable(vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch)).toBeNull()
  })
})

describe('checkForNewerBuild', () => {
  const latest = reply(rel('v1.0.1'))
  it('0.9.0 vs 1.0.1 is newer', async () => {
    expect(await checkForNewerBuild('0.9.0', latest)).toEqual({
      state: 'newer',
      latest: '1.0.1',
      url: 'https://github.com/Jozkah/flint/releases/tag/v1.0.1',
    })
  })
  it('1.0.1 vs 1.0.1 is up to date', async () => {
    expect((await checkForNewerBuild('1.0.1', latest)).state).toBe('current')
  })
  it('an installed build ahead of the latest stable is up to date', async () => {
    expect((await checkForNewerBuild('1.0.2', latest)).state).toBe('current')
    expect((await checkForNewerBuild('1.0.2-nightly.5', latest)).state).toBe('current')
  })
  it('is unknown with no readable latest or an unreadable installed version', async () => {
    expect(await checkForNewerBuild('0.9.0', reply({}, false, 404))).toEqual({ state: 'unknown' })
    expect((await checkForNewerBuild('test', latest)).state).toBe('unknown')
  })
})

it('links to the release page of the tag', () => {
  expect(releaseUrl('0.9.0')).toBe('https://github.com/Jozkah/flint/releases/tag/v0.9.0')
})
