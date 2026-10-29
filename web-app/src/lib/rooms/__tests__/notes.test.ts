import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRoomController } from '../controller'
import { useRoomsStore } from '../store'
import { setRoomPersistence } from '../persistence'
import { breachNote, describeBreach } from '../limits'
import { rt } from '../text'
import {
  defaultProviders,
  memoryPersistence,
  messagesOf,
  providerLookup,
  scriptedStream,
  uniqueText,
} from './helpers'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))

const initialStore = useRoomsStore.getState()
beforeEach(() => useRoomsStore.setState(initialStore, true))

describe('typed room notes', () => {
  it('a breach note is its key, and its text is that key rendered', () => {
    expect(breachNote('maxTurns')).toEqual({ key: 'breachTurns' })
    expect(breachNote('weird' as never)).toEqual({ key: 'breachOther', values: { limit: 'weird' } })
    expect(describeBreach('maxTurns')).toBe(rt('breachTurns'))
  })

  it('the engine stores a limit stop as a note with its text fallback', async () => {
    const persistence = memoryPersistence()
    setRoomPersistence(persistence)
    let id = 0
    const ctl = createRoomController({
      persistence: () => persistence,
      streamReply: scriptedStream(() => ({ text: uniqueText() })).fn,
      now: () => 1_000,
      newId: () => `id-${++id}`,
      lookupProvider: providerLookup(defaultProviders()),
      contextWindow: () => 32_000,
      sleep: async () => true,
    })
    const room = await ctl.createRoom({
      title: 't',
      participants: [
        { name: 'A', model: { provider: 'provider-a', id: 'model-1' } },
        { name: 'B', model: { provider: 'provider-b', id: 'model-2' } },
      ],
      limits: { maxTurns: 1 },
    })
    await ctl.start(room.id)
    await ctl.whenIdle(room.id)
    const notes = messagesOf(persistence, room.id).filter((m) => m.kind === 'system' && m.note)
    const stop = notes.find((m) => m.note?.key === 'breachTurns')
    expect(stop).toBeDefined()
    expect(stop?.text).toBe(rt('breachTurns'))
  })
})
