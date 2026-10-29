import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRoomController } from '../controller'
import { useRoomsStore } from '../store'
import { setRoomPersistence } from '../persistence'
import {
  defaultProviders,
  memoryPersistence,
  providerLookup,
  scriptedStream,
} from './helpers'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))

// Characterization of participant and moderator normalisation, written
// through the controller before the helpers moved to participants.ts.
const initialStore = useRoomsStore.getState()

function setup() {
  const persistence = memoryPersistence()
  setRoomPersistence(persistence)
  let id = 0
  return createRoomController({
    persistence: () => persistence,
    streamReply: scriptedStream(() => ({ text: 'x' })).fn,
    now: () => 1_000,
    newId: () => `id-${++id}`,
    lookupProvider: providerLookup(defaultProviders()),
    contextWindow: () => 32_000,
    sleep: async () => true,
  })
}

const a = { provider: 'provider-a', id: 'model-1' }
const b = { provider: 'provider-b', id: 'model-2' }

beforeEach(() => {
  useRoomsStore.setState(initialStore, true)
})

describe('participant normalisation', () => {
  it('trims and caps fields, keeps valid pricing and drops the rest', async () => {
    const ctl = setup()
    const room = await ctl.createRoom({
      title: 't',
      participants: [
        {
          name: '  ' + 'N'.repeat(100) + '  ',
          role: '  ' + 'r'.repeat(300),
          model: a,
          toolAccess: 'edit',
          pricing: { inputPerMTokUsd: 1.5, outputPerMTokUsd: 3 },
          assistantId: '  asst-1  ',
        },
        {
          name: 'Bob',
          model: b,
          toolAccess: 'full',
          pricing: { inputPerMTokUsd: -1, outputPerMTokUsd: 3 },
          assistantId: '   ',
          workProfile: 'not-a-profile' as never,
        },
      ],
    })
    const [p0, p1] = room.participants
    expect(p0.name).toBe('N'.repeat(80))
    expect(p0.role).toBe('r'.repeat(200))
    expect(p0.toolAccess).toBe('edit')
    expect(p0.pricing).toEqual({ inputPerMTokUsd: 1.5, outputPerMTokUsd: 3 })
    expect(p0.assistantId).toBe('asst-1')
    expect(p0.availability).toEqual({ state: 'unknown' })
    expect(p0.removed).toBe(false)
    expect(p0.order).toBe(0)
    expect(p1.toolAccess).toBe('none')
    expect('pricing' in p1).toBe(false)
    expect('assistantId' in p1).toBe(false)
    expect('workProfile' in p1).toBe(false)
    expect(p1.order).toBe(1)
  })

  it('refuses a blank name', async () => {
    const ctl = setup()
    await expect(
      ctl.createRoom({ title: 't', participants: [{ name: '   ', model: a }] })
    ).rejects.toMatchObject({
      code: 'invalid_room',
      message: 'A participant needs a name.',
    })
  })

  it('refuses more participants than the ceiling', async () => {
    const ctl = setup()
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `P${i}`,
      model: b,
    }))
    await expect(
      ctl.createRoom({ title: 't', participants: many })
    ).rejects.toMatchObject({ code: 'invalid_room' })
  })

  it('fills moderator defaults', async () => {
    const ctl = setup()
    const room = await ctl.createRoom({
      title: 't',
      participants: [{ name: 'A', model: a }],
    })
    expect(room.moderator).toEqual({
      enabled: false,
      name: 'Moderator',
      model: null,
    })
    const named = await ctl.createRoom({
      title: 't',
      participants: [{ name: 'A', model: a }],
      moderator: { enabled: true, name: '   ', model: { provider: 'p', id: 'm' } },
    })
    expect(named.moderator).toEqual({
      enabled: true,
      name: 'Moderator',
      model: { provider: 'p', id: 'm' },
    })
  })
})
