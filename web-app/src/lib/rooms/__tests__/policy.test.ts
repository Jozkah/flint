import { describe, it, expect } from 'vitest'
import {
  activeParticipants,
  beginSpeakingTurn,
  consecutiveRun,
  markSpoken,
  nextSpeaker,
  resolveParticipant,
} from '../policy'
import { makeRoom, participant } from './helpers'
import { ROOM_SCHEMA_VERSION, type Room, type RoomMessage } from '../types'

const speech = (pid: string, status: RoomMessage['status'] = 'complete'): RoomMessage => ({
  v: ROOM_SCHEMA_VERSION,
  id: Math.random().toString(36),
  roomId: 'room-1',
  seq: 1,
  turnId: 't',
  author: { kind: 'participant', participantId: pid, name: pid },
  to: { kind: 'room' },
  kind: 'speech',
  text: 'x',
  round: 1,
  createdAt: 1,
  status,
})

const three = () =>
  makeRoom({
    participants: [
      participant('a', 'Alice', 'provider-a', 'model-1', { order: 0 }),
      participant('b', 'Bob', 'provider-b', 'model-2', { order: 1 }),
      participant('c', 'Carol', 'provider-c', 'model-3', { order: 2 }),
    ],
  })

/** Simulate n round-robin turns and return the speaker order. */
function simulate(room: Room, n: number): string[] {
  const order: string[] = []
  const messages: RoomMessage[] = []
  for (let i = 0; i < n; i++) {
    const choice = nextSpeaker({ room, messages })
    if (choice.kind !== 'speaker') break
    room = beginSpeakingTurn(room)
    order.push(choice.participant.id)
    messages.push(speech(choice.participant.id))
    room = markSpoken(room, choice.participant.id)
  }
  return order
}

describe('speaking policy', () => {
  it('round-robin follows order and counts rounds', () => {
    let room = three()
    expect(simulate(room, 7)).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a'])
    room = beginSpeakingTurn(room)
    room = markSpoken(markSpoken(markSpoken(room, 'a'), 'b'), 'c')
    expect(room.usage.rounds).toBe(1)
    room = beginSpeakingTurn(room)
    expect(room.round).toBe(2)
    expect(room.spokenThisRound).toEqual([])
  })

  it('skips removed and unavailable participants', () => {
    const room = three()
    room.participants[1] = { ...room.participants[1], removed: true }
    room.participants[2] = {
      ...room.participants[2],
      availability: { state: 'unavailable', reason: 'model-missing', message: 'x', at: 1 },
    }
    expect(activeParticipants(room).map((p) => p.id)).toEqual(['a'])
  })

  it('user-selected waits for the user, then honours the choice', () => {
    const room = { ...three(), mode: 'user-selected' as const }
    expect(nextSpeaker({ room, messages: [] })).toEqual({ kind: 'awaiting-user' })
    const chosen = nextSpeaker({ room: { ...room, nextSpeakerId: 'c' }, messages: [] })
    expect(chosen).toMatchObject({ kind: 'speaker', via: 'user-selected' })
    expect(chosen.kind === 'speaker' && chosen.participant.id).toBe('c')
  })

  it('moderator-selected resolves by id or name, falling back with a reason', () => {
    const room = { ...three(), mode: 'moderator-selected' as const }
    const d = (next: string | null) => ({ next, request: null, disagreements: [], converged: false, stop: false, reason: '' })
    const byName = nextSpeaker({ room, messages: [], directive: d('carol') })
    expect(byName.kind === 'speaker' && byName.participant.id).toBe('c')
    expect(byName).toMatchObject({ via: 'moderator' })
    const byId = nextSpeaker({ room, messages: [], directive: d('b') })
    expect(byId.kind === 'speaker' && byId.participant.id).toBe('b')
    const unknown = nextSpeaker({ room, messages: [], directive: d('Zed') })
    expect(unknown).toMatchObject({ kind: 'speaker', via: 'fallback' })
    expect(unknown.kind === 'speaker' && unknown.note).toContain('Zed')
    const missing = nextSpeaker({ room, messages: [], directive: null, directiveProblem: 'Bad JSON.' })
    expect(missing).toMatchObject({ kind: 'speaker', via: 'fallback' })
    expect(missing.kind === 'speaker' && missing.note).toContain('Bad JSON.')
  })

  // #180: outside user-selected, a blocked selectNext was dropped with no note.
  it.each(['round-robin', 'moderator-selected'] as const)(
    'explains a blocked explicit choice in %s mode',
    (mode) => {
      const room = { ...three(), mode, round: 1, spokenThisRound: ['a'] }
      const choice = nextSpeaker({ room, messages: [speech('a')], override: 'a' })
      expect(choice).toMatchObject({ kind: 'speaker', via: 'fallback' })
      expect(choice.kind === 'speaker' && choice.participant.id).not.toBe('a')
      expect(choice.kind === 'speaker' && choice.note).toContain('Alice would exceed the consecutive-turn limit')
    }
  )

  it('enforces maxConsecutivePerParticipant', () => {
    const room = { ...three(), mode: 'moderator-selected' as const, round: 1, spokenThisRound: ['a'] }
    const d = { next: 'Alice', request: null, disagreements: [], converged: false, stop: false, reason: '' }
    const choice = nextSpeaker({ room, messages: [speech('a')], directive: d })
    expect(choice).toMatchObject({ kind: 'speaker', via: 'fallback' })
    expect(choice.kind === 'speaker' && choice.participant.id).not.toBe('a')
    const two = { ...room, limits: { ...room.limits, maxConsecutivePerParticipant: 2 } }
    const allowed = nextSpeaker({ room: two, messages: [speech('a')], directive: d })
    expect(allowed.kind === 'speaker' && allowed.participant.id).toBe('a')
    expect(consecutiveRun([speech('b'), speech('a'), speech('a')])).toEqual({ participantId: 'a', count: 2 })
  })

  it('resolveParticipant accepts @names', () => {
    expect(resolveParticipant('@bob', three().participants)?.id).toBe('b')
    expect(resolveParticipant('', three().participants)).toBeNull()
  })
})
