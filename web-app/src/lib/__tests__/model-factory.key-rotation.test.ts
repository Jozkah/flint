import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiKeyRotatingFetch } from '../model-factory'

type Answer = { status: number; headers?: Record<string, string> }

// The key a request carried, read back from its Authorization header.
const keyOf = (init: RequestInit | undefined): string =>
  (new Headers(init?.headers).get('authorization') ?? '').replace('Bearer ', '')

describe('api key rotation memory', () => {
  let answers: Record<string, Answer>
  let seen: string[]
  let base: ReturnType<typeof vi.fn>

  const build = (keys: string[]) =>
    createApiKeyRotatingFetch(
      base as unknown as typeof globalThis.fetch,
      keys,
      {},
      'authorization-bearer'
    )

  beforeEach(() => {
    answers = {}
    seen = []
    base = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const key = keyOf(init)
      seen.push(key)
      const a = answers[key] ?? { status: 200 }
      return new Response(a.status === 200 ? '{}' : 'no', {
        status: a.status,
        headers: a.headers,
      })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('goes straight to the key that worked on the next request', async () => {
    answers.A = { status: 401 }
    const f = build(['A', 'B'])
    const first = await f('https://api.test/v1/chat')
    expect(first.status).toBe(200)
    expect(seen).toEqual(['A', 'B'])

    seen.length = 0
    const second = await f('https://api.test/v1/chat')
    expect(second.status).toBe(200)
    expect(seen).toEqual(['B'])
  })

  it('skips a rate limited key until its Retry-After has passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    answers.A = { status: 429, headers: { 'retry-after': '2' } }
    const f = build(['A', 'B'])
    await f('https://api.test/v1/chat')
    expect(seen).toEqual(['A', 'B'])

    // Still inside the wait: A is not asked at all.
    answers.A = { status: 200 }
    seen.length = 0
    await f('https://api.test/v1/chat')
    expect(seen).toEqual(['B'])

    // Wait over: A is back in the rotation once B starts refusing.
    vi.setSystemTime(new Date('2026-01-01T00:00:03Z'))
    answers.B = { status: 429, headers: { 'retry-after': '60' } }
    seen.length = 0
    const res = await f('https://api.test/v1/chat')
    expect(res.status).toBe(200)
    expect(seen).toEqual(['B', 'A'])
  })

  it('returns a 403 without trying the other keys', async () => {
    answers.A = { status: 403 }
    const f = build(['A', 'B'])
    const res = await f('https://api.test/v1/chat')
    expect(res.status).toBe(403)
    expect(seen).toEqual(['A'])
  })

  it('still tries every key when all of them are refused', async () => {
    answers.A = { status: 401 }
    answers.B = { status: 401 }
    const f = build(['A', 'B'])
    const first = await f('https://api.test/v1/chat')
    expect(first.status).toBe(401)
    expect(seen).toEqual(['A', 'B'])

    seen.length = 0
    const second = await f('https://api.test/v1/chat')
    expect(second.status).toBe(401)
    expect(seen).toEqual(['A', 'B'])
  })
})
