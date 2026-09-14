import { describe, it, expect } from 'vitest'
import { isRepetitive, jaccard, recentSpeech, shingles, similarity } from '../repetition'
import { addressLabel, parseAddress } from '../addressing'
import { extractJsonObject, parseDirective } from '../moderator'
import { parseVote, tallyVotes } from '../votes'
import {
  DISSENT_TRUNCATION_MARKER,
  MAX_DISSENT_POSITION_CHARS,
  capPosition,
  composeSynthesisText,
  computeDissent,
} from '../synthesis'
import { makeRoom, participant } from './helpers'
import { ROOM_SCHEMA_VERSION, type RoomMessage } from '../types'

const msg = (over: Partial<RoomMessage>): RoomMessage => ({
  v: ROOM_SCHEMA_VERSION,
  id: Math.random().toString(36).slice(2),
  roomId: 'room-1',
  seq: 1,
  turnId: 't',
  author: { kind: 'participant', participantId: 'p-a', name: 'Alice' },
  to: { kind: 'room' },
  kind: 'speech',
  text: '',
  round: 1,
  createdAt: 1,
  status: 'complete',
  ...over,
})

describe('repetition', () => {
  it('normalises case and punctuation into word 3-shingles', () => {
    expect([...shingles('The quick, brown FOX!')]).toEqual(['the quick brown', 'quick brown fox'])
    expect(similarity('The quick brown fox.', 'the QUICK brown fox')).toBe(1)
  })
  it('jaccard of disjoint sets is 0', () => {
    expect(jaccard(shingles('a b c d'), shingles('e f g h'))).toBe(0)
  })
  it('compares against the last 2x active speech messages only', () => {
    const texts = ['alpha beta gamma delta', 'one two three four', 'red green blue cyan', 'up down left right', 'x y z w', 'k l m n']
    const messages = texts.map((text) => msg({ text }))
    const recent = recentSpeech(messages, 2)
    expect(recent.map((m) => m.text)).toEqual(texts.slice(-4))
    expect(isRepetitive('alpha beta gamma delta', recent, 0.9)).toBe(false)
    expect(isRepetitive('X, y z w', recent, 0.9)).toBe(true)
  })
})

describe('addressing', () => {
  const participants = [
    participant('p1', 'Ann', 'p', 'm'),
    participant('p2', 'Ann Lee', 'p', 'm'),
    participant('p3', 'Gone', 'p', 'm', { removed: true }),
  ]
  it('parses reserved tokens', () => {
    expect(parseAddress('@room hello', participants)).toEqual({ kind: 'room' })
    expect(parseAddress('  @Moderator: please', participants)).toEqual({ kind: 'moderator' })
    expect(parseAddress('@USER question', participants)).toEqual({ kind: 'user' })
  })
  it('matches participant names case-insensitively, longest first', () => {
    expect(parseAddress('@ann lee, what now?', participants)).toEqual({ kind: 'participant', participantId: 'p2' })
    expect(parseAddress('@Ann what now?', participants)).toEqual({ kind: 'participant', participantId: 'p1' })
  })
  it('unknown, removed or partial-word tokens stay room', () => {
    expect(parseAddress('@nobody hi', participants)).toEqual({ kind: 'room' })
    expect(parseAddress('@Gone hi', participants)).toEqual({ kind: 'room' })
    expect(parseAddress('@Annabel hi', participants)).toEqual({ kind: 'room' })
    expect(parseAddress('hi @Ann', participants)).toEqual({ kind: 'room' })
  })
  it('first token wins and moderator name is recognised', () => {
    expect(parseAddress('@Chair @Ann hi', participants, 'Chair')).toEqual({ kind: 'moderator' })
  })
  it('labels addresses', () => {
    const room = makeRoom()
    expect(addressLabel({ kind: 'participant', participantId: 'p-b' }, room)).toBe('Bob')
    expect(addressLabel({ kind: 'user' }, room)).toBe('User')
  })
})

describe('moderator directive parsing', () => {
  it('parses a plain JSON object', () => {
    expect(parseDirective('{"next":"Bob","request":"why?","disagreements":["cost"],"converged":false,"stop":false,"reason":"r"}')).toEqual({
      next: 'Bob',
      request: 'why?',
      disagreements: ['cost'],
      converged: false,
      stop: false,
      reason: 'r',
    })
  })
  it('handles code fences, trailing prose, missing fields and string booleans', () => {
    const d = parseDirective('Sure! Here it is:\n```json\n{"next": "Alice", "converged": "true",}\n```\nHope that helps {really}.')
    expect(d).toEqual({ next: 'Alice', request: null, disagreements: [], converged: true, stop: false, reason: '' })
  })
  it('ignores braces inside strings', () => {
    expect(extractJsonObject('x {"reason": "a } b", "next": "B"} y')).toBe('{"reason": "a } b", "next": "B"}')
  })
  it('returns null for invalid or irrelevant output', () => {
    expect(parseDirective('Bob should speak next.')).toBeNull()
    expect(parseDirective('{not json')).toBeNull()
    expect(parseDirective('{"foo": 1}')).toBeNull()
    expect(parseDirective('[1,2]')).toBeNull()
  })
  it('never carries fields other than the directive shape', () => {
    const d = parseDirective('{"next":"Bob","toolAccess":"read","limits":{"maxTurns":999}}') as Record<string, unknown>
    expect(Object.keys(d).sort()).toEqual(['converged', 'disagreements', 'next', 'reason', 'request', 'stop'])
  })
})

describe('votes', () => {
  it('parses agree/disagree/abstain leniently', () => {
    expect(parseVote('AGREE\nIt is sound.')).toMatchObject({ choice: 'agree', reason: 'It is sound.', parsed: true })
    expect(parseVote('**Disagree** - too costly')).toMatchObject({ choice: 'disagree', parsed: true, reason: 'too costly' })
    expect(parseVote('Vote: abstain. Not my field.')).toMatchObject({ choice: 'abstain', parsed: true })
    expect(parseVote('{"vote": "disagree", "reason": "no"}')).toMatchObject({ choice: 'disagree', reason: 'no' })
  })
  it('unparseable becomes abstain with raw text kept', () => {
    const v = parseVote('I have mixed feelings, I do not agree entirely')
    expect(v).toEqual({ choice: 'abstain', reason: '', parsed: false, raw: 'I have mixed feelings, I do not agree entirely' })
  })
  it('tallies the latest vote per participant for a call', () => {
    const call = msg({ id: 'call-1', kind: 'vote-call', author: { kind: 'user' }, text: 'Ship it' })
    const vote = (pid: string, choice: 'agree' | 'disagree' | 'abstain', callId = 'call-1') =>
      msg({ kind: 'vote', author: { kind: 'participant', participantId: pid, name: pid }, vote: { callId, choice, proposal: 'Ship it' } })
    const t = tallyVotes([call, vote('a', 'disagree'), vote('a', 'agree'), vote('b', 'disagree'), vote('c', 'abstain'), vote('d', 'agree', 'other')], 'call-1')
    expect(t).toMatchObject({ agree: 1, disagree: 1, abstain: 1, total: 3, proposal: 'Ship it' })
  })
})

describe('synthesis dissent caps', () => {
  it('caps a long dissenting position once, with a marker, and keeps the text within the limit', () => {
    const long = `DISAGREE\n${'x'.repeat(10_000)}`
    const messages = [
      msg({ kind: 'final-position', author: { kind: 'participant', participantId: 'b', name: 'Bob' }, text: long }),
    ]
    const [d] = computeDissent(messages)
    expect(d.position.length).toBe(MAX_DISSENT_POSITION_CHARS)
    expect(d.position.endsWith(DISSENT_TRUNCATION_MARKER)).toBe(true)
    expect(long.startsWith(d.position.slice(0, -DISSENT_TRUNCATION_MARKER.length))).toBe(true)
    expect(capPosition('short')).toBe('short')
    const text = composeSynthesisText('y'.repeat(30_000), [d])
    expect(text.length).toBeLessThanOrEqual(20_000)
    expect(text).toContain('Dissenting positions (recorded verbatim)')
  })

  it('does not split a surrogate pair when capping', () => {
    const capped = capPosition('😀'.repeat(5_000))
    const body = capped.slice(0, -DISSENT_TRUNCATION_MARKER.length)
    expect(body.length % 2).toBe(0)
  })
})

describe('synthesis dissent', () => {
  it('keeps every dissenting final position verbatim', () => {
    const fp = (pid: string, name: string, text: string) =>
      msg({ kind: 'final-position', author: { kind: 'participant', participantId: pid, name }, text })
    const messages = [
      fp('a', 'Alice', 'AGREE\nShip it.'),
      fp('b', 'Bob', 'DISAGREE\nThe migration costs 40 hours we have not budgeted.'),
      fp('c', 'Cy', 'Undecided, really.'),
    ]
    const dissent = computeDissent(messages)
    expect(dissent).toEqual([{ participantId: 'b', name: 'Bob', position: 'DISAGREE\nThe migration costs 40 hours we have not budgeted.' }])
    const text = composeSynthesisText('Everyone agrees.', dissent)
    expect(text.startsWith('Everyone agrees.')).toBe(true)
    expect(text).toContain('DISAGREE\nThe migration costs 40 hours we have not budgeted.')
  })
  it('includes participants whose latest vote disagrees', () => {
    const call = msg({ id: 'c1', kind: 'vote-call', author: { kind: 'user' }, text: 'P' })
    const v = msg({ kind: 'vote', text: 'DISAGREE\nno', author: { kind: 'participant', participantId: 'x', name: 'Xi' }, vote: { callId: 'c1', choice: 'disagree', proposal: 'P' } })
    expect(computeDissent([call, v])).toEqual([{ participantId: 'x', name: 'Xi', position: 'DISAGREE\nno' }])
  })
})
