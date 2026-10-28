import { describe, it, expect } from 'vitest'
import { checkChannel, directionOf, findInstalled, parseReleases } from '../buildUpdate'

const rel = (tag: string, published: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/Jozkah/flint/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  published_at: published,
  target_commitish: 'main',
  ...extra,
})

const payload = [
  rel('nightly-20261028-04', '2026-10-28T05:00:00Z', { prerelease: true, target_commitish: 'abc1234def' }),
  rel('nightly-20261027-03', '2026-10-27T04:00:00Z', { prerelease: true, target_commitish: 'fedcba9876' }),
  rel('nightly-20261028-17', '2026-10-28T18:00:00Z', { prerelease: true, draft: true }),
  rel('v1.1.0-beta.1', '2026-10-20T00:00:00Z', { prerelease: true }),
  rel('v1.0.1', '2026-10-15T00:00:00Z'),
  rel('v1.0.0', '2026-10-01T00:00:00Z'),
  rel('not-a-version', '2026-10-01T00:00:00Z'),
]

describe('parseReleases', () => {
  it('sorts by publish date and sorts each tag into its channel', () => {
    const list = parseReleases(payload)
    expect(list.map((r) => [r.tag, r.channel])).toEqual([
      ['nightly-20261028-04', 'nightly'],
      ['nightly-20261027-03', 'nightly'],
      ['v1.1.0-beta.1', 'beta'],
      ['v1.0.1', 'release'],
      ['v1.0.0', 'release'],
    ])
  })

  it('treats a release marked prerelease as beta even without a pre-release suffix', () => {
    expect(parseReleases([rel('v2.0.0', '2026-10-01T00:00:00Z', { prerelease: true })])[0].channel).toBe('beta')
  })

  it('never keeps a link outside the Flint repo', () => {
    const [r] = parseReleases([rel('v1.0.1', '', { html_url: 'https://evil.example/x' })])
    expect(r.url).toBe('https://github.com/Jozkah/flint/releases/tag/v1.0.1')
  })
})

describe('directions', () => {
  const list = parseReleases(payload)
  const byTag = (tag: string) => list.find((r) => r.tag === tag)!

  it('compares release builds by version', () => {
    expect(directionOf(byTag('v1.0.0'), list, '1.0.1', '')).toBe('older')
    expect(directionOf(byTag('v1.0.1'), list, '1.0.1', '')).toBe('installed')
    expect(directionOf(byTag('v1.1.0-beta.1'), list, '1.0.1', '')).toBe('newer')
  })

  it('finds the installed nightly by its build commit and compares by date', () => {
    expect(findInstalled(list, '1.0.1', 'fedcba98765432')?.tag).toBe('nightly-20261027-03')
    expect(directionOf(byTag('nightly-20261028-04'), list, '1.0.1', 'fedcba98765432')).toBe('newer')
    // Going back to stable from a nightly is a downgrade even at the same version.
    expect(directionOf(byTag('v1.0.1'), list, '1.0.1', 'fedcba98765432')).toBe('older')
  })

  it('cannot place a nightly when the installed build is not in the list', () => {
    expect(directionOf(byTag('nightly-20261028-04'), list, '0.5.0', '')).toBe('unknown')
  })

  it('checks the newest release on the chosen channel', () => {
    expect(checkChannel(list, 'release', '1.0.0', '').state).toBe('newer')
    expect(checkChannel(list, 'release', '1.0.1', 'fedcba98765432').state).toBe('current')
    expect(checkChannel(list, 'nightly', '1.0.1', 'fedcba98765432')).toMatchObject({
      state: 'newer',
      latest: 'nightly-20261028-04',
    })
    expect(checkChannel(null, 'nightly', '1.0.1', '').state).toBe('unknown')
  })
})
