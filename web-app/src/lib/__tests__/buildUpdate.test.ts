import { describe, expect, it, vi } from 'vitest'
import { checkForNewerBuild, compareBuild, fetchTagCommit, releaseUrl } from '../buildUpdate'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const reply = (body: string, ok = true) => vi.fn().mockResolvedValue({ ok, text: async () => body }) as unknown as typeof fetch

describe('compareBuild', () => {
  it('is current when the build is the commit the tag points at, short hash included', () => {
    expect(compareBuild(A, A).state).toBe('current')
    expect(compareBuild(A.slice(0, 9), A).state).toBe('current')
  })

  it('is newer when the tag has moved on', () => {
    expect(compareBuild(A, B)).toEqual({ state: 'newer', latest: B })
  })

  it('does not guess without a recorded commit or a reachable release', () => {
    expect(compareBuild('', B).state).toBe('unknown')
    expect(compareBuild('not a hash', B).state).toBe('unknown')
    expect(compareBuild(A, null).state).toBe('unknown')
  })
})

describe('fetchTagCommit', () => {
  it('asks for the bare commit of the release tag', async () => {
    const f = reply(B)
    expect(await fetchTagCommit('0.9.0', f)).toBe(B)
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/Jozkah/flint/commits/v0.9.0')
    expect((init as RequestInit).headers).toEqual({ Accept: 'application/vnd.github.sha' })
  })

  it('returns null for an error status, an odd body or a network failure', async () => {
    expect(await fetchTagCommit('0.9.0', reply(B, false))).toBeNull()
    expect(await fetchTagCommit('0.9.0', reply('<html>'))).toBeNull()
    expect(await fetchTagCommit('0.9.0', vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch)).toBeNull()
  })

  it('checkForNewerBuild joins the two', async () => {
    expect((await checkForNewerBuild(A, '0.9.0', reply(B))).state).toBe('newer')
  })
})

it('links to the release page of the tag', () => {
  expect(releaseUrl('0.9.0')).toBe('https://github.com/Jozkah/flint/releases/tag/v0.9.0')
})
