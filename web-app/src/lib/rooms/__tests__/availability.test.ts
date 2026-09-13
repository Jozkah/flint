import { describe, it, expect } from 'vitest'
import {
  checkModel,
  clearSuspensions,
  effectiveToolAccess,
  markUnavailable,
  preflightParticipants,
} from '../availability'
import { makeProvider, makeRoom, participant, providerLookup } from './helpers'

const lookup = providerLookup([
  makeProvider('provider-a', [{ id: 'model-1', capabilities: ['tools'] }]),
  makeProvider('provider-b', ['model-2']),
  // A predefined remote provider with no credential.
  makeProvider('openai', ['model-9']),
])

describe('availability preflight', () => {
  it('detects missing provider, missing key, missing model and small context', () => {
    expect(checkModel({ provider: 'nope', id: 'm' }, lookup)?.reason).toBe('provider-missing')
    expect(checkModel({ provider: 'openai', id: 'model-9' }, lookup)?.reason).toBe('provider-not-configured')
    expect(checkModel({ provider: 'provider-b', id: 'gone' }, lookup)?.reason).toBe('model-missing')
    expect(
      checkModel({ provider: 'provider-b', id: 'model-2' }, lookup, { minimumTokens: 4000, contextWindow: 2048 })?.reason
    ).toBe('context-too-small')
    expect(checkModel({ provider: 'provider-b', id: 'model-2' }, lookup, { minimumTokens: 1000, contextWindow: 8192 })).toBeNull()
  })

  it('marks participants and reports changes, keeping sticky suspensions', () => {
    const room = makeRoom({
      participants: [
        participant('a', 'A', 'provider-a', 'model-1'),
        participant('b', 'B', 'nope', 'm'),
        participant('c', 'C', 'provider-b', 'model-2', {
          availability: { state: 'unavailable', reason: 'repeated-errors', message: 'x', at: 1 },
        }),
      ],
    })
    const { room: next, changes } = preflightParticipants(room, { lookup, now: 5, minimumTokens: () => 10 })
    expect(next.participants.map((p) => p.availability.state)).toEqual(['available', 'unavailable', 'unavailable'])
    expect(changes.map((c) => c.participant.id)).toEqual(['a', 'b'])
    expect(clearSuspensions(next).participants[2].availability).toEqual({ state: 'unknown' })
  })

  it('suspension marks one participant only', () => {
    const room = markUnavailable(makeRoom(), 'p-b', 'repeated-errors', 'failed twice', 9)
    expect(room.participants[0].availability.state).toBe('unknown')
    expect(room.participants[1].availability).toMatchObject({ state: 'unavailable', reason: 'repeated-errors' })
  })

  it('tool access read runs as none, with a reason', () => {
    const withTools = participant('a', 'A', 'provider-a', 'model-1', { toolAccess: 'read' })
    const noTools = participant('b', 'B', 'provider-b', 'model-2', { toolAccess: 'read' })
    expect(effectiveToolAccess(withTools, lookup)).toMatchObject({ access: 'none' })
    expect(effectiveToolAccess(withTools, lookup).note).toContain('not yet available')
    expect(effectiveToolAccess(noTools, lookup).note).toContain('does not support tools')
    expect(effectiveToolAccess(participant('c', 'C', 'provider-a', 'model-1'), lookup)).toEqual({ access: 'none', note: null })
  })
})
