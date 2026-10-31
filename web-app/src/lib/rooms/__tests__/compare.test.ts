import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runRoom, type EngineUpdate } from '../engine'
import { buildPrompt, projectHistory } from '../context'
import { createRoomController } from '../controller'
import { useRoomsStore } from '../store'
import { setRoomPersistence } from '../persistence'
import { compareLayout } from '@/containers/rooms/roomUi'
import type { StreamReplyInput } from '../callError'
import {
  defaultProviders,
  engineDeps,
  makeRoom,
  memoryPersistence,
  messagesOf,
  participant,
  providerLookup,
  scriptedStream,
  seedMessages,
  seedRoom,
} from './helpers'
import { ROOM_SCHEMA_VERSION, type LiveTurn, type RoomMessage } from '../types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))

const signal = () => new AbortController().signal

const three = () => [
  participant('p-a', 'Alice', 'provider-a', 'model-1', { order: 0 }),
  participant('p-b', 'Bob', 'provider-b', 'model-2', { order: 1 }),
  participant('p-c', 'Carol', 'provider-c', 'model-3', { order: 2 }),
]

/** Name of the compare participant a prompt was built for. */
const nameOf = (input: StreamReplyInput) =>
  input.system.match(/^You are (.+?)(?: \([^)]*\))?, one of several/)?.[1] ?? '?'

const allText = (input: StreamReplyInput) =>
  [input.system, ...input.messages.map((m) => m.content)].join('\n')

const reply = (name: string, round: number) => `${name} answers round ${round} zq${name}${round}`

const msg = (over: Partial<RoomMessage> & Pick<RoomMessage, 'author' | 'kind' | 'text'>): RoomMessage => ({
  v: ROOM_SCHEMA_VERSION,
  id: `m-${Math.random().toString(36).slice(2)}`,
  roomId: 'room-1',
  seq: 0,
  turnId: null,
  to: { kind: 'room' },
  round: 1,
  createdAt: 1,
  status: 'complete',
  ...over,
})

const initialStore = useRoomsStore.getState()
beforeEach(() => {
  useRoomsStore.setState(initialStore, true)
})

describe('compare mode: context', () => {
  it("a participant's history holds the user and itself, never the other answers", async () => {
    const room = makeRoom({ mode: 'compare', participants: three() })
    const messages = [
      msg({ author: { kind: 'user' }, kind: 'user', text: 'What is 2+2?' }),
      msg({ author: { kind: 'participant', participantId: 'p-a', name: 'Alice' }, kind: 'speech', text: 'alice-says-four' }),
      msg({ author: { kind: 'participant', participantId: 'p-b', name: 'Bob' }, kind: 'speech', text: 'bob-says-four' }),
      msg({ author: { kind: 'moderator', name: 'Mod' }, kind: 'moderator-note', text: 'mod-note' }),
      msg({ author: { kind: 'user' }, kind: 'user', text: 'And 3+3?' }),
    ]
    const speaker = { kind: 'participant' as const, participant: room.participants[0] }
    const history = projectHistory(room, messages, speaker)
    expect(history.map((h) => h.source.text)).toEqual(['What is 2+2?', 'alice-says-four', 'And 3+3?'])
    expect(history[1].message.role).toBe('assistant')

    const built = await buildPrompt({ room, messages, speaker, contextWindow: 32_000, maxOutputTokens: 512 })
    expect(built.promptText).toContain('What is 2+2?')
    expect(built.promptText).not.toContain('bob-says-four')
    expect(built.promptText).not.toContain('mod-note')
    // No roster and no conclude signal: there is no discussion to join.
    expect(built.system).not.toContain('Bob')
    expect(built.system).toContain("you do not see the others' answers")

    // The same messages in a discussion room show everyone (unchanged).
    const discussion = projectHistory({ ...room, mode: 'round-robin' }, messages, speaker)
    expect(discussion.map((h) => h.source.text)).toContain('bob-says-four')
  })
})

describe('compare mode: engine', () => {
  it('asks every participant at once, each without the others, then waits for the user', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', participants: three() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Explain wind chill.' }])

    let round = 1
    let open = 0
    let peak = 0
    let release!: () => void
    let gate = new Promise<void>((r) => (release = r))
    const { fn, calls } = scriptedStream(async (input) => {
      open++
      peak = Math.max(peak, open)
      if (open === 3) release()
      await gate
      open--
      return { text: reply(nameOf(input), round) }
    })
    const updates: EngineUpdate[] = []
    let room = await runRoom('room-1', engineDeps(p, fn, { onUpdate: (u) => updates.push(u) }), signal())

    // All three were in flight together: parallel, not one after another.
    expect(peak).toBe(3)
    expect(calls.map(nameOf).sort()).toEqual(['Alice', 'Bob', 'Carol'])
    for (const c of calls) {
      const me = nameOf(c)
      expect(allText(c)).toContain('Explain wind chill.')
      for (const other of ['Alice', 'Bob', 'Carol'].filter((n) => n !== me)) {
        expect(allText(c)).not.toContain(`zq${other}`)
      }
    }
    expect(room.status).toBe('awaiting-user')
    expect(room.round).toBe(1)
    expect(room.usage.turns).toBe(3)
    // The header's "Questions n / max" reads this: one question answered.
    expect(room.usage.rounds).toBe(1)
    expect([...room.spokenThisRound].sort()).toEqual(['p-a', 'p-b', 'p-c'])
    const speech = messagesOf(p).filter((m) => m.kind === 'speech')
    expect(speech).toHaveLength(3)
    expect(new Set(speech.map((m) => m.round))).toEqual(new Set([1]))
    // Each live turn is cleared on its own when it ends.
    const cleared = updates.filter((u) => u.type === 'live' && !u.live && u.turnId)
    expect(cleared).toHaveLength(3)

    // The next user message opens round 2: each sees its own earlier answer only.
    await p.appendRoomRecord('room-1', {
      type: 'message',
      message: msg({ id: 'second-q', author: { kind: 'user' }, kind: 'user', text: 'Shorter please.' }),
    })
    round = 2
    gate = new Promise<void>((r) => (release = r))
    const before = calls.length
    room = await runRoom('room-1', engineDeps(p, fn), signal())
    const second = calls.slice(before)
    expect(second).toHaveLength(3)
    for (const c of second) {
      const me = nameOf(c)
      const text = allText(c)
      expect(text).toContain('Shorter please.')
      expect(c.messages.some((m) => m.role === 'assistant' && m.content === reply(me, 1))).toBe(true)
      for (const other of ['Alice', 'Bob', 'Carol'].filter((n) => n !== me)) {
        expect(text).not.toContain(`zq${other}`)
      }
    }
    expect(room.round).toBe(2)
    expect(room.usage.turns).toBe(6)
    expect(room.status).toBe('awaiting-user')
  })

  it('a round cut short is finished by the participants that had not answered', async () => {
    const p = memoryPersistence()
    await seedRoom(
      p,
      makeRoom({ mode: 'compare', participants: three(), round: 1, spokenThisRound: ['p-a'], status: 'paused' })
    )
    await seedMessages(p, 'room-1', [
      { author: { kind: 'user' }, text: 'Q' },
      { author: { kind: 'participant', participantId: 'p-a', name: 'Alice' }, text: 'Alice answered', kind: 'speech' },
    ])
    const { fn, calls } = scriptedStream((input) => ({ text: reply(nameOf(input), 1) }))
    const room = await runRoom('room-1', engineDeps(p, fn), signal())
    expect(calls.map(nameOf).sort()).toEqual(['Bob', 'Carol'])
    expect(room.round).toBe(1)
    expect(room.status).toBe('awaiting-user')
  })

  it('a failed answer does not stop the others', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', participants: three() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Q' }])
    const { fn } = scriptedStream((input) =>
      nameOf(input) === 'Bob'
        ? { error: Object.assign(new Error('bad request'), { statusCode: 400 }) }
        : { text: reply(nameOf(input), 1) }
    )
    const room = await runRoom('room-1', engineDeps(p, fn), signal())
    const speech = messagesOf(p).filter((m) => m.kind === 'speech')
    expect(speech.map((m) => [m.author.kind === 'participant' && m.author.name, m.status]).sort()).toEqual([
      ['Alice', 'complete'],
      ['Bob', 'failed'],
      ['Carol', 'complete'],
    ])
    expect(room.usage.turns).toBe(2)
    expect(room.status).toBe('awaiting-user')
  })
})

describe('compare mode: persistence and controller', () => {
  function setup() {
    const persistence = memoryPersistence()
    setRoomPersistence(persistence)
    let id = 0
    const { fn, calls } = scriptedStream((input) => ({ text: reply(nameOf(input), 1) }))
    const ctl = createRoomController({
      persistence: () => persistence,
      streamReply: fn,
      now: () => 1_000,
      newId: () => `id-${++id}`,
      lookupProvider: providerLookup(defaultProviders()),
      contextWindow: () => 32_000,
      sleep: async () => true,
    })
    return { persistence, ctl, calls }
  }
  const people = [
    { name: 'Alice', model: { provider: 'provider-a', id: 'model-1' } },
    { name: 'Bob', model: { provider: 'provider-b', id: 'model-2' } },
  ]

  it('the mode round-trips through create, edit, save and load', async () => {
    const { ctl, persistence } = setup()
    const created = await ctl.createRoom({ title: 'Compare', mode: 'compare', participants: people })
    expect(persistence.rooms.get(created.id)!.mode).toBe('compare')
    expect((await persistence.listRooms())[0].mode).toBe('compare')

    const other = await ctl.createRoom({ title: 'Talk', participants: people })
    const edited = await ctl.updateRoomSettings(other, { mode: 'compare' })
    expect(edited.mode).toBe('compare')

    await useRoomsStore.getState().openRoom(created.id)
    expect(useRoomsStore.getState().room?.mode).toBe('compare')
    expect(useRoomsStore.getState().summaries.find((s) => s.id === created.id)?.mode).toBe('compare')
  })

  it('a user message to a waiting compare room asks every participant', async () => {
    const { ctl, persistence, calls } = setup()
    const room = await ctl.createRoom({ title: 'Compare', mode: 'compare', participants: people })
    await ctl.start(room.id)
    await ctl.whenIdle(room.id)
    expect(persistence.rooms.get(room.id)!.status).toBe('awaiting-user')
    expect(calls).toHaveLength(2)
    await ctl.sendUserMessage(room.id, 'Next question', { kind: 'room' })
    await ctl.whenIdle(room.id)
    expect(calls).toHaveLength(4)
    expect(calls.slice(2).every((c) => allText(c).includes('Next question'))).toBe(true)
    expect(persistence.rooms.get(room.id)!.round).toBe(2)
  })
})

describe('compare mode: store and layout', () => {
  const live = (turnId: string, pid: string, text = ''): LiveTurn => ({
    roomId: 'room-1',
    turnId,
    author: { kind: 'participant', participantId: pid, name: pid },
    text,
    startedAt: 1,
  })

  it('keeps one live turn per participant and clears them one by one', () => {
    useRoomsStore.setState({ currentRoomId: 'room-1' })
    const apply = useRoomsStore.getState().applyEngineUpdate
    apply({ type: 'live', roomId: 'room-1', live: live('t1', 'a') })
    apply({ type: 'live', roomId: 'room-1', live: live('t2', 'b') })
    apply({ type: 'live', roomId: 'room-1', live: live('t1', 'a', 'hello') })
    let s = useRoomsStore.getState()
    expect(s.liveTurns.map((l) => [l.turnId, l.text])).toEqual([
      ['t1', 'hello'],
      ['t2', ''],
    ])
    expect(s.liveTurn?.turnId).toBe('t2')
    apply({ type: 'live', roomId: 'room-1', live: null, turnId: 't2' })
    s = useRoomsStore.getState()
    expect(s.liveTurns.map((l) => l.turnId)).toEqual(['t1'])
    expect(s.liveTurn?.turnId).toBe('t1')
    apply({ type: 'live', roomId: 'room-1', live: null })
    s = useRoomsStore.getState()
    expect(s.liveTurns).toEqual([])
    expect(s.liveTurn).toBeNull()
  })

  it("groups a round's answers into one row, closed by the next user message", () => {
    const a = (pid: string, round: number) =>
      msg({ author: { kind: 'participant', participantId: pid, name: pid }, kind: 'speech', text: pid, round })
    const u1 = msg({ author: { kind: 'user' }, kind: 'user', text: 'q1' })
    const sys = msg({ author: { kind: 'system' }, kind: 'system', text: 'note' })
    const u2 = msg({ author: { kind: 'user' }, kind: 'user', text: 'q2', round: 1 })
    const items = compareLayout([u1, a('a', 1), sys, a('b', 1), u2, a('a', 2), a('b', 2)])
    expect(items.map((i) => (i.kind === 'compare' ? `compare:${i.answers.length}` : i.message.text))).toEqual([
      'q1',
      'compare:2',
      'note',
      'q2',
      'compare:2',
    ])
  })
})
