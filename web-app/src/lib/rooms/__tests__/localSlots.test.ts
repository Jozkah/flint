import { describe, it, expect, vi } from 'vitest'
import { runRoom } from '../engine'
import { RoomCallError, toRoomCallError, type StreamReplyInput } from '../callError'
import { preflightParticipants } from '../availability'
import {
  engineDeps,
  makeProvider,
  makeRoom,
  memoryPersistence,
  messagesOf,
  participant,
  providerLookup,
  scriptedStream,
  seedMessages,
  seedRoom,
} from './helpers'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))

const nameOf = (input: StreamReplyInput) =>
  input.system.match(/^You are (.+?)(?: \([^)]*\))?, one of several/)?.[1] ?? '?'

const busyError = () =>
  Object.assign(new Error('all 1 model slots are busy; retry shortly'), { status: 503 })
const busy = () => new RoomCallError('busy', 'busy', 'all 1 model slots are busy; retry shortly')

const localPair = () => [
  participant('p-a', 'Alice', 'llamacpp', 'qwen', { order: 0 }),
  participant('p-b', 'Bob', 'llamacpp', 'gemma', { order: 1 }),
]
const localLookup = () =>
  providerLookup([makeProvider('llamacpp', ['qwen', 'gemma']), makeProvider('provider-a', ['model-1'])])

const speechBy = (p: ReturnType<typeof memoryPersistence>, id: string) =>
  messagesOf(p).filter(
    (m) => m.kind === 'speech' && m.author.kind === 'participant' && m.author.participantId === id
  )

describe('local model slots (T6-095)', () => {
  it('classifies "slots are busy" as busy, not a provider failure', () => {
    expect(toRoomCallError(busyError()).kind).toBe('busy')
  })

  it('together with two local models on one engine runs them one at a time', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', participants: localPair() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q' }])
    let open = 0
    let peak = 0
    const { fn } = scriptedStream(async (input) => {
      open++
      peak = Math.max(peak, open)
      await new Promise((r) => setTimeout(r, 5))
      open--
      return { text: `${nameOf(input)} ok` }
    })
    const room = await runRoom(
      'room-1',
      engineDeps(p, fn, { lookupProvider: localLookup() }),
      new AbortController().signal
    )
    expect(peak).toBe(1)
    expect(room.participants.every((x) => x.availability.state !== 'unavailable')).toBe(true)
    expect(speechBy(p, 'p-a').at(-1)?.status).toBe('complete')
    expect(speechBy(p, 'p-b').at(-1)?.status).toBe('complete')
  })

  it('retries a busy slot with backoff and then answers', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', participants: localPair() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q' }])
    let bobTries = 0
    const { fn } = scriptedStream((input) =>
      nameOf(input) === 'Bob' && bobTries++ < 2 ? { error: busy() } : { text: `${nameOf(input)} ok` }
    )
    const sleeps: number[] = []
    const room = await runRoom(
      'room-1',
      engineDeps(p, fn, {
        lookupProvider: localLookup(),
        sleep: async (ms) => {
          sleeps.push(ms)
          return true
        },
      }),
      new AbortController().signal
    )
    expect(sleeps.length).toBe(2)
    expect(room.participants[1].availability.state).not.toBe('unavailable')
    expect(speechBy(p, 'p-b').at(-1)?.status).toBe('complete')
  })

  it('gives up after about a minute with a non-sticky busy reason', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', participants: localPair() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q' }])
    const { fn } = scriptedStream((input) =>
      nameOf(input) === 'Bob' ? { error: busy() } : { text: 'ok' }
    )
    const sleeps: number[] = []
    const room = await runRoom(
      'room-1',
      engineDeps(p, fn, {
        lookupProvider: localLookup(),
        sleep: async (ms) => {
          sleeps.push(ms)
          return true
        },
      }),
      new AbortController().signal
    )
    const total = sleeps.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(0)
    expect(total).toBeLessThanOrEqual(60_000)
    expect(room.participants[1].availability).toMatchObject({ state: 'unavailable', reason: 'busy' })
    // Not sticky: the next preflight checks the model again.
    const again = preflightParticipants(room, {
      lookup: localLookup(),
      now: 9,
      minimumTokens: () => 1,
    })
    expect(again.room.participants[1].availability.state).toBe('available')
  })

  it('stops waiting on abort', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', participants: localPair() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q' }])
    const ctl = new AbortController()
    const { fn } = scriptedStream(() => ({ error: busy() }))
    const room = await runRoom(
      'room-1',
      engineDeps(p, fn, {
        lookupProvider: localLookup(),
        sleep: async () => {
          ctl.abort()
          return false
        },
      }),
      ctl.signal
    )
    expect(room.participants.every((x) => x.availability.state !== 'unavailable')).toBe(true)
  })
})

describe('retrying a failed local model (T6-012)', () => {
  const failedBob = () => {
    const people = localPair()
    people[1] = {
      ...people[1],
      availability: { state: 'unavailable', reason: 'load-failed', message: 'could not start', at: 1 },
    }
    return people
  }

  it('compare-run clears a sticky load failure and tries the model again', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', status: 'awaiting-user', participants: failedBob() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q' }])
    const { fn, calls } = scriptedStream((input) => ({ text: `${nameOf(input)} ok` }))
    const room = await runRoom(
      'room-1',
      engineDeps(p, fn, { lookupProvider: localLookup() }),
      new AbortController().signal,
      { command: { kind: 'compare-run', participantIds: ['p-b'], scope: 'latest' } }
    )
    expect(calls.map(nameOf)).toEqual(['Bob'])
    expect(room.participants[1].availability.state).not.toBe('unavailable')
  })

  it('run all retries unavailable participants too', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', status: 'awaiting-user', participants: failedBob() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q' }])
    const { fn, calls } = scriptedStream((input) => ({ text: `${nameOf(input)} ok` }))
    await runRoom(
      'room-1',
      engineDeps(p, fn, { lookupProvider: localLookup() }),
      new AbortController().signal,
      { command: { kind: 'compare-run', participantIds: null, scope: 'latest' } }
    )
    expect(calls.map(nameOf).sort()).toEqual(['Alice', 'Bob'])
  })
})
