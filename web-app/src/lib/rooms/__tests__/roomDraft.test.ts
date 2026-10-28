import { describe, it, expect } from 'vitest'
import {
  budgetFromDraft,
  draftFromRoom,
  parsePricing,
  roomDraftReducer,
  toBudgetDraft,
  toLimitDraft,
  type RoomDraft,
} from '../roomDraft'
import type { Participant, Room } from '../types'

const participant = (id: string, name: string, over: Partial<Participant> = {}): Participant =>
  ({
    id,
    name,
    role: '',
    model: { provider: 'p', id: 'm' },
    toolAccess: 'none',
    ...over,
  }) as unknown as Participant

const limits = {
  maxRounds: 5,
  maxTurns: null,
  maxConsecutivePerParticipant: null,
  maxTotalTokens: null,
  maxOutputTokensPerTurn: null,
  maxDurationMs: 120_000,
  maxRepetitiveTurns: null,
  repetitionSimilarity: null,
  maxCostUsd: null,
}

const room = (over: Partial<Room> = {}): Room =>
  ({
    id: 'r1',
    rev: 1,
    title: 'Plan',
    objective: 'Decide',
    mode: 'round-robin',
    moderator: { enabled: false, name: '', model: null },
    limits,
    toolBudget: undefined,
    participants: [],
    ...over,
  }) as unknown as Room

const base = (): RoomDraft => draftFromRoom(room(), [participant('a', 'Ann'), participant('b', 'Bo')])

describe('draftFromRoom', () => {
  it('shows limits as text, with the duration in minutes', () => {
    const d = base()
    expect(d.limits.maxRounds).toBe('5')
    expect(d.limits.maxDurationMs).toBe('2')
    expect(d.limits.maxTurns).toBe('')
    expect(d.participants.map((p) => p.name)).toEqual(['Ann', 'Bo'])
    expect(d.participants[0].source.id).toBe('a')
  })
})

describe('roomDraftReducer', () => {
  it('edit changes one field and nothing else', () => {
    const d = base()
    const next = roomDraftReducer(d, { type: 'edit', field: 'title', value: 'New' })
    expect(next.title).toBe('New')
    expect(next.objective).toBe('Decide')
    expect(next.participants).toBe(d.participants)
  })

  it('updateParticipant patches only that participant', () => {
    const d = base()
    const next = roomDraftReducer(d, { type: 'updateParticipant', id: 'b', patch: { name: 'Bob' } })
    expect(next.participants.map((p) => p.name)).toEqual(['Ann', 'Bob'])
    expect(next.participants[0]).toBe(d.participants[0])
  })

  it('reset replaces the whole draft with the room as it is now', () => {
    const edited = roomDraftReducer(base(), { type: 'edit', field: 'title', value: 'Typed' })
    const next = roomDraftReducer(edited, {
      type: 'reset',
      room: room({ title: 'From engine' }),
      participants: [participant('c', 'Cy')],
    })
    expect(next.title).toBe('From engine')
    expect(next.participants.map((p) => p.id)).toEqual(['c'])
  })

  it('syncParticipants keeps edits, refreshes sources, drops the gone and adds the new', () => {
    let d = base()
    d = roomDraftReducer(d, { type: 'updateParticipant', id: 'a', patch: { name: 'Typed name' } })
    const fresh = participant('a', 'Ann', { role: 'lead' })
    const next = roomDraftReducer(d, {
      type: 'syncParticipants',
      participants: [fresh, participant('c', 'Cy')],
    })
    expect(next.participants.map((p) => p.id)).toEqual(['a', 'c'])
    // The person's edit survives; the source is the new revision's.
    expect(next.participants[0].name).toBe('Typed name')
    expect(next.participants[0].source).toBe(fresh)
  })

  it('syncParticipants leaves the settings fields alone', () => {
    const d = roomDraftReducer(base(), { type: 'edit', field: 'objective', value: 'Mine' })
    const next = roomDraftReducer(d, { type: 'syncParticipants', participants: [] })
    expect(next.objective).toBe('Mine')
    expect(next.participants).toEqual([])
  })
})

describe('draft helpers', () => {
  it('round-trips a tool budget and drops an empty one', () => {
    expect(budgetFromDraft(toBudgetDraft(undefined))).toBeNull()
    expect(budgetFromDraft({ maxToolCalls: '4', maxSteps: '', toolTimeoutSec: 'x' })).toEqual({
      maxToolCalls: 4,
    })
  })

  it('reads pricing only when both prices are valid', () => {
    expect(parsePricing({ priceIn: '1', priceOut: '2' })).toEqual({
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 2,
    })
    expect(parsePricing({ priceIn: '1', priceOut: '' })).toBeUndefined()
    expect(parsePricing({ priceIn: '-1', priceOut: '2' })).toBeUndefined()
  })

  it('shows a null limit as an empty field', () => {
    expect(toLimitDraft(limits as never).maxCostUsd).toBe('')
  })
})
