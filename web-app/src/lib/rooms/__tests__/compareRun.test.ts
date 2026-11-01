import { describe, it, expect, vi } from 'vitest'
import { runRoom } from '../engine'
import { createRoomController } from '../controller'
import { compareGrid, compareHistory, missingQuestions, participantsMissingEarlier } from '../compareGrid'
import { compareExport } from '../compareExport'
import type { StreamReplyInput } from '../callError'
import {
  defaultProviders,
  providerLookup,
  engineDeps,
  makeRoom,
  memoryPersistence,
  messagesOf,
  participant,
  scriptedStream,
  seedMessages,
  seedRoom,
} from './helpers'
import { ROOM_SCHEMA_VERSION, type RoomMessage } from '../types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))

const three = () => [
  participant('p-a', 'Alice', 'provider-a', 'model-1', { order: 0 }),
  participant('p-b', 'Bob', 'provider-b', 'model-2', { order: 1 }),
  participant('p-c', 'Carol', 'provider-c', 'model-3', { order: 2 }),
]

const nameOf = (input: StreamReplyInput) =>
  input.system.match(/^You are (.+?)(?: \([^)]*\))?, one of several/)?.[1] ?? '?'

const userMsg = (id: string, text: string): RoomMessage => ({
  v: ROOM_SCHEMA_VERSION,
  id,
  roomId: 'room-1',
  seq: 0,
  turnId: null,
  author: { kind: 'user' },
  to: { kind: 'room' },
  kind: 'user',
  text,
  round: 1,
  createdAt: 5,
  status: 'complete',
})

const speech = (p: ReturnType<typeof memoryPersistence>) =>
  messagesOf(p).filter((m) => m.kind === 'speech')

describe('compare one-by-one', () => {
  it('asks participants strictly in order, never two at once', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', compareRun: 'one-by-one', participants: three() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q one' }])
    let open = 0
    let peak = 0
    const { fn, calls } = scriptedStream(async (input) => {
      open++
      peak = Math.max(peak, open)
      await new Promise((r) => setTimeout(r, 5))
      open--
      return { text: `${nameOf(input)} says hi` }
    })
    const room = await runRoom('room-1', engineDeps(p, fn), new AbortController().signal)
    expect(peak).toBe(1)
    expect(calls.map(nameOf)).toEqual(['Alice', 'Bob', 'Carol'])
    expect(room.status).toBe('awaiting-user')
    expect(speech(p)).toHaveLength(3)
  })

  it('a failing model does not block the next one', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', compareRun: 'one-by-one', participants: three() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q one' }])
    const { fn, calls } = scriptedStream((input) =>
      nameOf(input) === 'Bob'
        ? { error: Object.assign(new Error('model failed to load'), { status: 500 }) }
        : { text: `${nameOf(input)} ok` }
    )
    await runRoom('room-1', engineDeps(p, fn), new AbortController().signal)
    expect(calls.map(nameOf)).toContain('Carol')
    const done = speech(p).filter((m) => m.status === 'complete')
    expect(done.map((m) => (m.author.kind === 'participant' ? m.author.name : ''))).toEqual([
      'Alice',
      'Carol',
    ])
  })

  it('stops between turns on abort and resumes with those left', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', compareRun: 'one-by-one', participants: three() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q one' }])
    const ac = new AbortController()
    const { fn, calls } = scriptedStream((input) => {
      // Stop pressed while Bob is answering: Alice is done, Bob is cut short.
      if (nameOf(input) === 'Bob') ac.abort()
      return { text: `${nameOf(input)} ok` }
    })
    const paused = await runRoom('room-1', engineDeps(p, fn), ac.signal)
    expect(paused.status).toBe('paused')
    expect(calls.map(nameOf)).toEqual(['Alice', 'Bob'])
    expect(speech(p).map((m) => m.status)).toEqual(['complete', 'interrupted'])

    const again = scriptedStream((input) => ({ text: `${nameOf(input)} later` }))
    const room = await runRoom('room-1', engineDeps(p, again.fn), new AbortController().signal)
    expect(again.calls.map(nameOf)).toEqual(['Bob', 'Carol'])
    expect(room.status).toBe('awaiting-user')
  })

  it('a new question after a roster change asks everyone, in roster order (R-044)', async () => {
    const p = memoryPersistence()
    const [alice, bob, carol] = three()
    await seedRoom(p, makeRoom({ mode: 'compare', compareRun: 'one-by-one', participants: [alice, bob] }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q one' }])
    await runRoom('room-1', engineDeps(p, scriptedStream((i) => ({ text: `${nameOf(i)} 1` })).fn), new AbortController().signal)
    // Carol joins (the round Alice and Bob closed is now "incomplete"), then Q two.
    const stored = p.rooms.get('room-1')!
    p.rooms.set('room-1', { ...stored, participants: [...stored.participants, carol] })
    await p.appendRoomRecord('room-1', { type: 'message', message: userMsg('q-two', 'Q two') })
    const { fn, calls } = scriptedStream((input) => ({ text: `${nameOf(input)} 2` }))
    let n = 0
    const room = await runRoom('room-1', engineDeps(p, fn, { newId: () => `b-${++n}` }), new AbortController().signal)
    expect(calls.map(nameOf)).toEqual(['Alice', 'Bob', 'Carol'])
    const answeredTwo = speech(p)
      .filter((m) => m.compare?.replyTo === 'q-two' && m.status === 'complete')
      .map((m) => (m.author.kind === 'participant' ? m.author.participantId : ''))
    expect(answeredTwo).toEqual(['p-a', 'p-b', 'p-c'])
    expect(room.status).toBe('awaiting-user')
    // Carol never saw Q one: her answer says it covers it too (R-043).
    const two = speech(p).filter((m) => m.compare?.replyTo === 'q-two')
    expect(two.find((m) => m.author.kind === 'participant' && m.author.participantId === 'p-c')!.compare!.catchUp).toEqual([
      { id: expect.any(String), text: 'Q one' },
    ])
    expect(two.find((m) => m.author.kind === 'participant' && m.author.participantId === 'p-a')!.compare!.catchUp).toBeUndefined()
  })

  it('a participant switched back on answers the next question with the others, in order (R-044)', async () => {
    const parts = three()
    parts[0] = { ...parts[0], compareSkip: true }
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', compareRun: 'one-by-one', participants: parts }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q one' }])
    await runRoom('room-1', engineDeps(p, scriptedStream((i) => ({ text: `${nameOf(i)} 1` })).fn), new AbortController().signal)
    const stored = p.rooms.get('room-1')!
    p.rooms.set('room-1', {
      ...stored,
      participants: stored.participants.map((x) => ({ ...x, compareSkip: undefined })),
    })
    await p.appendRoomRecord('room-1', { type: 'message', message: userMsg('q-two', 'Q two') })
    const { fn, calls } = scriptedStream((input) => ({ text: `${nameOf(input)} 2` }))
    await runRoom('room-1', engineDeps(p, fn), new AbortController().signal)
    expect(calls.map(nameOf)).toEqual(['Alice', 'Bob', 'Carol'])
  })

  it('a room started with no question asks its objective, so the answers have a row', async () => {
    const p = memoryPersistence()
    await seedRoom(
      p,
      makeRoom({ mode: 'compare', compareRun: 'one-by-one', participants: three().slice(0, 2), objective: 'Name a prime.' })
    )
    const { fn } = scriptedStream((input) => ({ text: `${nameOf(input)} ok` }))
    await runRoom('room-1', engineDeps(p, fn), new AbortController().signal)
    const grid = compareGrid(messagesOf(p))
    expect(grid.questions.map((q) => q.text)).toEqual(['Name a prime.'])
    const q = grid.questions[0].id
    expect(missingQuestions(grid, 'p-a')).toEqual([])
    expect(grid.answers.get(q)!.filter((m) => m.status === 'complete')).toHaveLength(2)
  })

  it('a question written to one participant is answered by that one only', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', compareRun: 'one-by-one', participants: three() }))
    await p.appendRoomRecord('room-1', {
      type: 'message',
      message: { ...userMsg('q-bob', 'Q for Bob'), to: { kind: 'participant', participantId: 'p-b' } },
    })
    const { fn, calls } = scriptedStream((input) => ({ text: `${nameOf(input)} ok` }))
    const room = await runRoom('room-1', engineDeps(p, fn), new AbortController().signal)
    expect(calls.map(nameOf)).toEqual(['Bob'])
    expect(room.status).toBe('awaiting-user')
  })

  it('leaves out a participant switched off for the run', async () => {
    const parts = three()
    parts[1] = { ...parts[1], compareSkip: true }
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', compareRun: 'one-by-one', participants: parts }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q one' }])
    const { fn, calls } = scriptedStream((input) => ({ text: `${nameOf(input)} ok` }))
    const room = await runRoom('room-1', engineDeps(p, fn), new AbortController().signal)
    expect(calls.map(nameOf)).toEqual(['Alice', 'Carol'])
    expect(room.status).toBe('awaiting-user')
  })
})

describe('compare answers record what wrote them', () => {
  it('stores model, provider, question, duration and token stats', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', compareRun: 'one-by-one', participants: three().slice(0, 2) }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q one' }])
    const clock = { t: 1_000 }
    const { fn } = scriptedStream(() => {
      clock.t += 250
      return { text: 'answer', usage: { inputTokens: 10, outputTokens: 20 } }
    })
    await runRoom('room-1', engineDeps(p, fn, { clock }), new AbortController().signal)
    const a = speech(p).find((m) => m.author.kind === 'participant' && m.author.name === 'Alice')!
    expect(a.compare).toEqual({ provider: 'provider-a', model: 'model-1', replyTo: 'seed-0', durationMs: 250 })
    expect(a.usage?.outputTokens).toBe(20)
    expect(a.createdAt).toBeGreaterThan(0)
  })
})

describe('compare-run command', () => {
  it('answers the earlier questions for a late participant, in order, from its own context', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', compareRun: 'one-by-one', participants: three() }))
    await seedMessages(p, 'room-1', [
      { author: { kind: 'user' }, text: 'Q one' },
      { author: { kind: 'participant', participantId: 'p-a', name: 'Alice' }, text: 'A1 by alice' },
      { author: { kind: 'participant', participantId: 'p-b', name: 'Bob' }, text: 'B1 by bob' },
      { author: { kind: 'user' }, text: 'Q two' },
      { author: { kind: 'participant', participantId: 'p-a', name: 'Alice' }, text: 'A2 by alice' },
      { author: { kind: 'participant', participantId: 'p-b', name: 'Bob' }, text: 'B2 by bob' },
    ])
    const { fn, calls } = scriptedStream((input, i) => ({ text: `carol answer ${i + 1}` }))
    const room = await runRoom('room-1', engineDeps(p, fn), new AbortController().signal, {
      command: { kind: 'compare-run', participantIds: ['p-c'], scope: 'missing' },
    })
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => nameOf(c) === 'Carol')).toBe(true)
    // The header's "Questions n / max": both questions now have answers (RQA-013).
    expect(room.usage.rounds).toBe(2)
    // First replay: only Q one, nothing from the others.
    const first = calls[0].messages.map((m) => m.content).join('\n')
    expect(first).toContain('Q one')
    expect(first).not.toContain('Q two')
    expect(first).not.toContain('by alice')
    // Second: Q one, its own answer, then Q two.
    const second = calls[1].messages
    const texts = second.map((m) => m.content).join('\n')
    expect(texts.indexOf('Q one')).toBeLessThan(texts.indexOf('carol answer 1'))
    expect(texts.indexOf('carol answer 1')).toBeLessThan(texts.indexOf('Q two'))
    expect(second.find((m) => m.role === 'assistant')?.content).toBe('carol answer 1')
    expect(texts).not.toContain('by bob')

    const carol = speech(p).filter((m) => m.author.kind === 'participant' && m.author.participantId === 'p-c')
    expect(carol.map((m) => m.compare?.replyTo)).toEqual(['seed-0', 'seed-3'])
    const grid = compareGrid(messagesOf(p))
    expect(missingQuestions(grid, 'p-c')).toEqual([])
    expect(room.status).toBe('awaiting-user')
  })

  it('"latest" runs one participant again and keeps both runs', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', participants: three().slice(0, 2) }))
    await seedMessages(p, 'room-1', [
      { author: { kind: 'user' }, text: 'Q one' },
      { author: { kind: 'participant', participantId: 'p-a', name: 'Alice' }, text: 'old alice' },
    ])
    const { fn, calls } = scriptedStream(() => ({ text: 'new alice' }))
    await runRoom('room-1', engineDeps(p, fn), new AbortController().signal, {
      command: { kind: 'compare-run', participantIds: ['p-a'], scope: 'latest' },
    })
    expect(calls).toHaveLength(1)
    // The re-run does not see its own earlier answer to the same question.
    expect(calls[0].messages.map((m) => m.content).join('\n')).not.toContain('old alice')
    const grid = compareGrid(messagesOf(p))
    expect(grid.answers.get('seed-0')!.map((m) => m.text)).toEqual(['old alice', 'new alice'])
  })
})

describe('compare questions addressed to one participant', () => {
  const toAlice = (id: string, text: string): RoomMessage => ({
    ...userMsg(id, text),
    to: { kind: 'participant', participantId: 'p-a' },
  })
  const answer = (id: string, pid: string, replyTo: string): RoomMessage => ({
    ...userMsg(id, 'answer'),
    kind: 'speech',
    author: { kind: 'participant', participantId: pid, name: pid },
    compare: { provider: 'x', model: 'y', replyTo },
  })

  it('is owed only by its addressee; room questions by everyone', () => {
    const grid = compareGrid([toAlice('q1', 'one'), answer('a1', 'p-a', 'q1'), userMsg('q2', 'two')])
    expect(missingQuestions(grid, 'p-b').map((q) => q.id)).toEqual(['q2'])
    expect(missingQuestions(grid, 'p-a').map((q) => q.id)).toEqual(['q2'])
    const room = makeRoom({ mode: 'compare', participants: three() })
    expect(participantsMissingEarlier(room, grid)).toEqual([])
    const unanswered = compareGrid([userMsg('q1', 'one'), userMsg('q2', 'two')])
    expect(participantsMissingEarlier(room, unanswered).map((p) => p.id)).toEqual(['p-a', 'p-b', 'p-c'])
  })

  it('"missing" does not ask another participant a question put to one', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', participants: three() }))
    await p.appendRoomRecord('room-1', { type: 'message', message: toAlice('q1', 'Q for Alice') })
    await p.appendRoomRecord('room-1', { type: 'message', message: answer('a1', 'p-a', 'q1') })
    const { fn, calls } = scriptedStream((input) => ({ text: `${nameOf(input)} ok` }))
    await runRoom('room-1', engineDeps(p, fn), new AbortController().signal, {
      command: { kind: 'compare-run', participantIds: ['p-b'], scope: 'missing' },
    })
    expect(calls).toHaveLength(0)
  })

  it('"latest" for everyone asks only the addressee', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', participants: three() }))
    await p.appendRoomRecord('room-1', { type: 'message', message: toAlice('q1', 'Q for Alice') })
    const { fn, calls } = scriptedStream((input) => ({ text: `${nameOf(input)} ok` }))
    await runRoom('room-1', engineDeps(p, fn), new AbortController().signal, {
      command: { kind: 'compare-run', participantIds: null, scope: 'latest' },
    })
    expect(calls.map(nameOf)).toEqual(['Alice'])
  })
})

describe('compareHistory', () => {
  it('places a later answer next to its question', () => {
    const q1 = userMsg('q1', 'one')
    const q2 = userMsg('q2', 'two')
    const late: RoomMessage = {
      ...userMsg('a1', 'late answer'),
      kind: 'speech',
      author: { kind: 'participant', participantId: 'p-c', name: 'Carol' },
      compare: { provider: 'x', model: 'y', replyTo: 'q1' },
    }
    const out = compareHistory([q1, q2, late], 'p-c', 'q2')
    expect(out.map((m) => m.id)).toEqual(['q1', 'a1', 'q2'])
  })
})

describe('compareExport', () => {
  it('has questions as rows and model runs as columns, with stats', () => {
    const room = makeRoom({ mode: 'compare', participants: three().slice(0, 2) })
    const ans = (id: string, pid: string, name: string, q: string, at: number, text: string): RoomMessage => ({
      ...userMsg(id, text),
      kind: 'speech',
      createdAt: at,
      author: { kind: 'participant', participantId: pid, name },
      compare: { provider: pid === 'p-a' ? 'provider-a' : 'provider-b', model: pid === 'p-a' ? 'model-1' : 'model-2', replyTo: q, durationMs: 1200 },
      usage: { inputTokens: 5, outputTokens: 40, estimated: false, tokensPerSecond: 33.3 },
    })
    const messages = [
      userMsg('q1', 'What is 2+2?'),
      ans('a', 'p-a', 'Alice', 'q1', Date.UTC(2026, 0, 1), 'four'),
      ans('b', 'p-b', 'Bob', 'q1', Date.UTC(2026, 0, 1), 'it is | four'),
      ans('c', 'p-a', 'Alice', 'q1', Date.UTC(2026, 5, 1), 'four again'),
    ]
    const out = compareExport(room, messages, Date.UTC(2026, 6, 1))
    expect(out.json.questions).toHaveLength(1)
    expect(out.json.columns.map((c) => `${c.participant}#${c.run}`)).toEqual(['Alice#1', 'Alice#2', 'Bob#1'])
    const cell = out.json.cells.find((c) => c.text === 'four again')!
    expect(cell).toMatchObject({ questionId: 'q1', outputTokens: 40, tokensPerSecond: 33.3, durationMs: 1200, model: 'model-1' })
    expect(out.markdown).toContain('| Question |')
    // Re-runs name their time and run, so the headers differ (R-028).
    expect(out.markdown).toContain('Alice · model-1 · 2026-01-01 00:00 (run 1)')
    expect(out.markdown).toContain('Alice · model-1 · 2026-06-01 00:00 (run 2)')
    expect(out.markdown).toContain('Bob · model-2 · 2026-01-01 |')
    expect(out.markdown).toContain('it is \\| four')
  })
})

describe('compare settings persist', () => {
  it('saves the run choice and a participant switched off, and reads them back', async () => {
    const persistence = memoryPersistence()
    let id = 0
    const ctl = createRoomController({
      persistence: () => persistence,
      streamReply: scriptedStream(() => ({ text: 'x' })).fn,
      now: () => 1_000,
      newId: () => `id-${++id}`,
      lookupProvider: providerLookup(defaultProviders()),
      contextWindow: () => 32_000,
      sleep: async () => true,
    })
    const room = await ctl.createRoom({
      title: 'Cmp',
      mode: 'compare',
      compareRun: 'one-by-one',
      participants: [
        { name: 'Alice', model: { provider: 'provider-a', id: 'model-1' } },
        { name: 'Bob', model: { provider: 'provider-b', id: 'model-2' } },
      ],
    })
    expect(room.compareRun).toBe('one-by-one')
    const bob = room.participants[1].id
    let next = await ctl.updateRoomSettings(room, { participants: [{ id: bob, compareSkip: true }] })
    let stored = (await persistence.getRoom(room.id)).room
    expect(stored.compareRun).toBe('one-by-one')
    expect(stored.participants[1].compareSkip).toBe(true)
    next = await ctl.updateRoomSettings(next, {
      compareRun: 'together',
      participants: [{ id: bob, compareSkip: false }],
    })
    stored = (await persistence.getRoom(room.id)).room
    expect(stored.compareRun).toBeUndefined()
    expect(stored.participants[1].compareSkip).toBeUndefined()
    expect(next.rev).toBe(stored.rev)
  })
})
