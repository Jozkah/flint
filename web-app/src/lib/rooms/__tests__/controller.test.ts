import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRoomController } from '../controller'
import { useRoomsStore } from '../store'
import { setRoomPersistence } from '../persistence'
import { useToolApproval } from '@/hooks/useToolApproval'
import {
  abortError,
  defaultProviders,
  memoryPersistence,
  messagesOf,
  providerLookup,
  scriptedStream,
  speakerOf,
  uniqueText,
} from './helpers'
import type { StreamReplyInput } from '../callError'
import type { StreamReply } from '../callError'
import { CONCLUDE_SIGNAL } from '../consensus'

// buildPrompt resolves the rooms skill catalog via the Tauri bridge; these
// controller tests exercise turn-taking, not extension resolution, so stub
// it to return no skills rather than pulling in a real invoke bridge.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))

const initialStore = useRoomsStore.getState()

function setup(streamReply: StreamReply) {
  const persistence = memoryPersistence()
  setRoomPersistence(persistence)
  let id = 0
  const ctl = createRoomController({
    persistence: () => persistence,
    streamReply,
    now: () => 1_000,
    newId: () => `id-${++id}`,
    lookupProvider: providerLookup(defaultProviders()),
    contextWindow: () => 32_000,
    sleep: async () => true,
  })
  return { persistence, ctl }
}

const models = {
  a: { provider: 'provider-a', id: 'model-1' }, // has tools
  b: { provider: 'provider-b', id: 'model-2' },
}

async function createDefault(ctl: ReturnType<typeof setup>['ctl'], over = {}) {
  return ctl.createRoom({
    title: 'Plan review',
    objective: 'Pick a plan',
    participants: [
      { name: 'Alice', model: models.a },
      { name: 'Bob', model: models.b },
    ],
    limits: { maxTurns: 2 },
    ...over,
  })
}

function blockingStream() {
  let resolveStarted!: () => void
  const started = new Promise<void>((r) => (resolveStarted = r))
  const fn: StreamReply = async (input: StreamReplyInput) => {
    input.onText('partial ')
    resolveStarted()
    return new Promise<never>((_, reject) => {
      input.signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
  }
  return { fn, started }
}

beforeEach(() => {
  useRoomsStore.setState(initialStore, true)
  vi.restoreAllMocks()
})

describe('room editor', () => {
  it('createRoom clamps limits and forces toolAccess none for models without tools', async () => {
    const { ctl, persistence } = setup(scriptedStream(() => ({ text: 'x' })).fn)
    const room = await ctl.createRoom({
      title: '  Plan  ',
      participants: [
        { name: 'Alice', model: models.a, toolAccess: 'read' },
        { name: 'Bob', model: models.b, toolAccess: 'read' },
      ],
      limits: { maxTurns: 1e9, maxOutputTokensPerTurn: -3 },
    })
    expect(room.status).toBe('draft')
    expect(room.rev).toBe(1)
    expect(room.title).toBe('Plan')
    expect(room.limits.maxTurns).toBe(200)
    expect(room.limits.maxOutputTokensPerTurn).toBe(1)
    expect(room.participants.map((p) => p.toolAccess)).toEqual(['read', 'none'])
    expect(persistence.rooms.get(room.id)).toEqual(room)
  })

  it('a new participant defaults to read-only for a tool-capable model', async () => {
    const { ctl } = setup(scriptedStream(() => ({ text: 'x' })).fn)
    // No toolAccess given: the controller applies its default.
    const room = await ctl.createRoom({
      title: 'Defaults',
      participants: [
        { name: 'Alice', model: models.a }, // tool-capable -> read
        { name: 'Bob', model: models.b }, // no tools -> none
      ],
    })
    expect(room.participants.map((p) => p.toolAccess)).toEqual(['read', 'none'])

    const added = await ctl.addParticipant(room, { name: 'Cara', model: models.a })
    expect(added.participants.find((p) => p.name === 'Cara')?.toolAccess).toBe('read')

    // An explicit 'none' is still honoured.
    const room2 = await ctl.createRoom({
      title: 'Explicit none',
      participants: [
        { name: 'Dan', model: models.a, toolAccess: 'none' },
        { name: 'Eve', model: models.b },
      ],
    })
    expect(room2.participants.map((p) => p.toolAccess)).toEqual(['none', 'none'])
  })

  it('rejects duplicate names', async () => {
    const { ctl } = setup(scriptedStream(() => ({ text: 'x' })).fn)
    await expect(
      ctl.createRoom({ title: 't', participants: [{ name: 'Ann', model: models.a }, { name: 'ann', model: models.b }] })
    ).rejects.toMatchObject({ code: 'invalid_room' })
  })

  it('updateRoomSettings edits and adds participants, clamps limits, and refuses while running', async () => {
    const { ctl } = setup(scriptedStream(() => ({ text: 'x' })).fn)
    const room = await createDefault(ctl)
    const updated = await ctl.updateRoomSettings(room, {
      title: 'Renamed',
      limits: { maxRounds: 999 },
      participants: [
        { id: room.participants[1].id, name: 'Robert', toolAccess: 'read', pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } },
        { name: 'Carol', role: 'analyst', model: models.a, toolAccess: 'read' },
      ],
    })
    expect(updated.title).toBe('Renamed')
    expect(updated.limits.maxRounds).toBe(50)
    expect(updated.participants.map((p) => [p.name, p.toolAccess])).toEqual([
      // Alice (tool-capable model) kept her default read-only from createRoom.
      ['Alice', 'read'],
      ['Robert', 'none'],
      ['Carol', 'read'],
    ])
    expect(updated.participants[1].pricing).toEqual({ inputPerMTokUsd: 1, outputPerMTokUsd: 2 })
    await expect(ctl.updateRoomSettings({ ...updated, status: 'running' }, { title: 'x' })).rejects.toMatchObject({
      code: 'invalid_room',
    })
  })

  it('back-to-back edits from the same rendered room all land (no stale_revision)', async () => {
    const { ctl, persistence } = setup(scriptedStream(() => ({ text: 'x' })).fn)
    const room = await createDefault(ctl)
    // Both calls use the same snapshot, as two quick clicks in the editor do.
    const [, , renamed] = await Promise.all([
      ctl.addParticipant(room, { name: 'Cara', model: models.a }),
      ctl.removeParticipant(room, room.participants[1].id),
      ctl.updateRoomSettings(room, { title: 'Renamed' }),
    ])
    expect(renamed.title).toBe('Renamed')
    const stored = persistence.rooms.get(room.id)!
    expect(stored.title).toBe('Renamed')
    expect(stored.participants.map((p) => [p.name, !!p.removed])).toEqual([
      ['Alice', false],
      ['Bob', true],
      ['Cara', false],
    ])
  })

  it('removeParticipant marks removed; deleteRoom removes everywhere', async () => {
    const { ctl, persistence } = setup(scriptedStream(() => ({ text: 'x' })).fn)
    const room = await createDefault(ctl)
    const after = await ctl.removeParticipant(room, room.participants[0].id)
    expect(after.participants[0].removed).toBe(true)
    expect(after.participants).toHaveLength(2)
    await ctl.deleteRoom(room.id)
    expect(persistence.rooms.has(room.id)).toBe(false)
    expect(useRoomsStore.getState().summaries.some((s) => s.id === room.id)).toBe(false)
  })
})

describe('room controller', () => {
  it('start runs to a limit; the store mirrors the persisted transcript', async () => {
    const approvals = vi.spyOn(useToolApproval, 'getState')
    const { fn, calls } = scriptedStream(() => ({ text: uniqueText() }))
    const { ctl, persistence } = setup(fn)
    const room = await createDefault(ctl)
    await useRoomsStore.getState().loadRoom(room.id)
    await ctl.start(room.id)
    expect(ctl.isRunning(room.id)).toBe(true)
    await ctl.whenIdle(room.id)
    expect(ctl.isRunning(room.id)).toBe(false)
    expect(calls.map(speakerOf)).toEqual(['Alice', 'Bob'])
    const saved = persistence.rooms.get(room.id)!
    expect(saved.stopReason).toEqual({ kind: 'limit', limit: 'maxTurns' })
    const state = useRoomsStore.getState()
    expect(state.room).toEqual(saved)
    expect(state.journal).toEqual(persistence.journals.get(room.id))
    expect(state.messages.map((m) => m.id)).toEqual(messagesOf(persistence, room.id).map((m) => m.id))
    expect(state.runningRoomIds).toEqual([])
    expect(state.liveTurn).toBeNull()
    expect(approvals).not.toHaveBeenCalled()
  })

  it('a limit-stopped room is not resumed by a message, but extendLimit continues it', async () => {
    const { fn, calls } = scriptedStream(() => ({ text: uniqueText() }))
    const { ctl, persistence } = setup(fn)
    const room = await createDefault(ctl) // maxTurns: 2
    await ctl.start(room.id)
    await ctl.whenIdle(room.id)
    expect(persistence.rooms.get(room.id)!.stopReason).toEqual({ kind: 'limit', limit: 'maxTurns' })
    const afterLimit = calls.length

    // A plain message records but does not resume (it would only re-trip it).
    await ctl.sendUserMessage(room.id, 'please continue', { kind: 'room' })
    await ctl.whenIdle(room.id)
    expect(ctl.isRunning(room.id)).toBe(false)
    expect(calls.length).toBe(afterLimit)
    expect(persistence.rooms.get(room.id)!.status).toBe('stopped')

    // Extending raises the blocking limit(s) for more rounds and continues,
    // carrying the message; the room actually runs further, not re-stops.
    await ctl.extendLimit(room.id, 3, 'go on', { kind: 'room' })
    await ctl.whenIdle(room.id)
    expect(calls.length).toBeGreaterThan(afterLimit)
    const saved = persistence.rooms.get(room.id)!
    expect(saved.limits.maxTurns).toBeGreaterThan(2)
    expect(messagesOf(persistence, room.id).some((m) => m.text === 'go on')).toBe(true)
  })

  it('a message resumes a room that had concluded', async () => {
    // Conclude on the 3rd turn: a lone or first-round conclusion is ignored, so
    // the signal must land after a full round has been spoken.
    let n = 0
    const { fn, calls } = scriptedStream(() =>
      n++ === 2 ? { text: `We agree. ${CONCLUDE_SIGNAL}` } : { text: uniqueText() }
    )
    const { ctl, persistence } = setup(fn)
    const room = await createDefault(ctl, { limits: { maxTurns: 6 } })
    await ctl.start(room.id)
    await ctl.whenIdle(room.id)
    expect(persistence.rooms.get(room.id)!).toMatchObject({
      status: 'completed',
      stopReason: { kind: 'converged', by: 'consensus' },
    })
    const afterConclude = calls.length

    await ctl.sendUserMessage(room.id, 'one more question', { kind: 'room' })
    await ctl.whenIdle(room.id)
    expect(calls.length).toBeGreaterThan(afterConclude)
    expect(messagesOf(persistence, room.id).some((m) => m.text === 'one more question')).toBe(true)
  })

  it('pauses to awaiting-user when a whole round is stuck waiting on the user', async () => {
    // Both participants keep addressing @user (asking for input they lack),
    // which would otherwise loop forever in round-robin.
    const { fn, calls } = scriptedStream(() => ({ text: `@user please paste the file ${uniqueText()}` }))
    const { ctl, persistence } = setup(fn)
    const room = await createDefault(ctl, { limits: { maxTurns: 20 } })
    await ctl.start(room.id)
    await ctl.whenIdle(room.id)
    const saved = persistence.rooms.get(room.id)!
    expect(saved.status).toBe('awaiting-user')
    // It stopped after roughly one round, not after burning every turn.
    expect(calls.length).toBeLessThanOrEqual(3)
  })

  it.each([
    ['pause', 'paused'],
    ['stop', 'stopped'],
    ['cancelTurn', 'paused'],
  ] as const)('%s mid-stream aborts the turn and saves the partial', async (action, status) => {
    const { fn, started } = blockingStream()
    const { ctl, persistence } = setup(fn)
    const room = await createDefault(ctl)
    await useRoomsStore.getState().loadRoom(room.id)
    await ctl.start(room.id)
    await started
    expect(useRoomsStore.getState().liveTurn?.text).toBe('partial ')
    await ctl[action](room.id)
    await ctl.whenIdle(room.id)
    expect(persistence.rooms.get(room.id)!.status).toBe(status)
    expect(messagesOf(persistence, room.id).find((m) => m.kind === 'speech')).toMatchObject({
      text: 'partial ',
      status: 'interrupted',
    })
    expect(useRoomsStore.getState().room?.status).toBe(status)
    expect(useRoomsStore.getState().liveTurn).toBeNull()
  })

  it('pause and stop while idle change status only', async () => {
    const { ctl, persistence } = setup(scriptedStream(() => ({ text: 'x' })).fn)
    const room = await createDefault(ctl, { mode: 'user-selected' })
    await ctl.start(room.id)
    await ctl.whenIdle(room.id)
    expect(persistence.rooms.get(room.id)!.status).toBe('awaiting-user')
    await ctl.pause(room.id)
    expect(persistence.rooms.get(room.id)!.status).toBe('paused')
    await ctl.stop(room.id)
    expect(persistence.rooms.get(room.id)!).toMatchObject({ status: 'stopped', stopReason: { kind: 'user' } })
  })

  it('selectNext continues a user-selected room with the chosen speaker', async () => {
    const { fn, calls } = scriptedStream(() => ({ text: uniqueText() }))
    const { ctl, persistence } = setup(fn)
    const room = await createDefault(ctl, { mode: 'user-selected', limits: { maxTurns: 5 } })
    await ctl.start(room.id)
    await ctl.whenIdle(room.id)
    expect(calls).toHaveLength(0)
    await ctl.selectNext(room.id, room.participants[1].id)
    await ctl.whenIdle(room.id)
    expect(calls.map(speakerOf)).toEqual(['Bob'])
    expect(persistence.rooms.get(room.id)!.status).toBe('awaiting-user')
  })

  it('sendUserMessage parses a leading address', async () => {
    const { ctl, persistence } = setup(scriptedStream(() => ({ text: 'x' })).fn)
    const room = await createDefault(ctl)
    await ctl.sendUserMessage(room.id, '@bob what is the risk?', { kind: 'room' })
    const m = messagesOf(persistence, room.id)[0]
    expect(m).toMatchObject({
      kind: 'user',
      author: { kind: 'user' },
      text: '@bob what is the risk?',
      to: { kind: 'participant', participantId: room.participants[1].id },
    })
  })

  it('callVote pauses a running room and records the vote', async () => {
    const { fn, calls } = scriptedStream((input) =>
      lastContentIncludes(input, 'A vote has been called') ? { text: 'AGREE\nyes' } : { text: uniqueText() }
    )
    const { ctl, persistence } = setup(fn)
    const room = await createDefault(ctl, { limits: { maxTurns: 1 } })
    await ctl.callVote(room.id, 'Adopt it')
    await ctl.whenIdle(room.id)
    expect(calls).toHaveLength(2)
    expect(messagesOf(persistence, room.id).filter((m) => m.kind === 'vote')).toHaveLength(2)
  })
})

function lastContentIncludes(input: StreamReplyInput, s: string) {
  return (input.messages[input.messages.length - 1]?.content ?? '').includes(s)
}
