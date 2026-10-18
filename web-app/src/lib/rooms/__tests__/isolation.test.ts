import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runRoom } from '../engine'
import { turnToolAccess } from '../callError'
import { isolationWanted, isolationNote, useIsolationNotes } from '../isolation'
import { buildPrompt } from '../context'
import type { StreamReplyInput } from '../callError'
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

const signal = () => new AbortController().signal

const toolProviders = () => [
  makeProvider('provider-a', [{ id: 'model-1', capabilities: ['tools'] }]),
  makeProvider('provider-b', [{ id: 'model-2', capabilities: ['tools'] }]),
]

const writers = (access: 'edit' | 'full' = 'edit') => [
  participant('p-a', 'Alice', 'provider-a', 'model-1', { order: 0, toolAccess: access }),
  participant('p-b', 'Bob', 'provider-b', 'model-2', { order: 1, toolAccess: access }),
]

const nameOf = (input: StreamReplyInput) =>
  input.system.match(/^You are (.+?)(?: \([^)]*\))?, one of several/)?.[1] ?? '?'

beforeEach(() => useIsolationNotes.setState({ notes: {} }))

describe('turnToolAccess with isolation', () => {
  it('keeps edit/full for an isolated compare participant', () => {
    expect(turnToolAccess({ mode: 'compare' }, 'edit', true)).toBe('edit')
    expect(turnToolAccess({ mode: 'compare' }, 'full', true)).toBe('full')
  })
  it('still downgrades without isolation, and never widens', () => {
    expect(turnToolAccess({ mode: 'compare' }, 'edit')).toBe('read')
    expect(turnToolAccess({ mode: 'compare' }, 'read', true)).toBe('read')
    expect(turnToolAccess({ mode: 'compare' }, 'none', true)).toBe('none')
  })
})

describe('isolationWanted', () => {
  it('needs compare mode, a folder and two or more writers', () => {
    expect(isolationWanted(makeRoom({ mode: 'compare', folder: 'C:/p', participants: writers() }))).toBe(true)
    expect(isolationWanted(makeRoom({ mode: 'compare', participants: writers() }))).toBe(false)
    expect(isolationWanted(makeRoom({ mode: 'round-robin', folder: 'C:/p', participants: writers() }))).toBe(false)
    const one = writers()
    one[1] = { ...one[1], toolAccess: 'read' }
    expect(isolationWanted(makeRoom({ mode: 'compare', folder: 'C:/p', participants: one }))).toBe(false)
    const removed = writers()
    removed[1] = { ...removed[1], removed: true }
    expect(isolationWanted(makeRoom({ mode: 'compare', folder: 'C:/p', participants: removed }))).toBe(false)
  })
})

describe('compare engine with isolated workspaces', () => {
  it('runs each writer in its own workspace with its access, states the path, and records changes', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', folder: 'C:/proj', extraFolders: ['C:/other'], participants: writers() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Fix the bug.' }])
    const ensure = vi.fn(async (_room: string, pid: string) => ({ path: `C:/data/rooms/room-1/workspaces/${pid}` }))
    const changes = vi.fn(async (_room: string, pid: string) =>
      pid === 'p-a' ? [{ path: 'a.ts', additions: 3, deletions: 1, excerpt: '+x' }] : []
    )
    const { fn, calls } = scriptedStream(async (input) => ({
      text: `${nameOf(input)} done`,
    }))
    await runRoom(
      'room-1',
      engineDeps(p, fn, { lookupProvider: providerLookup(toolProviders()), workspace: { ensure, changes } }),
      signal()
    )
    expect(ensure).toHaveBeenCalledTimes(2)
    for (const c of calls) {
      const pid = nameOf(c) === 'Alice' ? 'p-a' : 'p-b'
      expect(c.toolContext?.access).toBe('edit')
      expect(c.toolContext?.folder).toBe(`C:/data/rooms/room-1/workspaces/${pid}`)
      // Shared extra folders would be writable by both: dropped when isolated.
      expect(c.toolContext?.extraFolders ?? []).toEqual([])
      expect(c.system).toContain(`C:/data/rooms/room-1/workspaces/${pid}`)
      expect(c.system).toContain('isolated')
    }
    const speech = messagesOf(p).filter((m) => m.kind === 'speech')
    const alice = speech.find((m) => m.author.kind === 'participant' && m.author.participantId === 'p-a')!
    const bob = speech.find((m) => m.author.kind === 'participant' && m.author.participantId === 'p-b')!
    expect(alice.changes).toEqual({
      files: [{ path: 'a.ts', additions: 3, deletions: 1, excerpt: '+x' }],
      workspace: 'C:/data/rooms/room-1/workspaces/p-a',
    })
    expect(bob.changes).toBeUndefined()
  })

  it("marks each turn and records only that turn's change, with the cumulative one beside it", async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', folder: 'C:/proj', participants: writers() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Fix the bug.' }])
    const order: string[] = []
    const ensure = vi.fn(async (_room: string, pid: string) => ({ path: `C:/ws/${pid}` }))
    const markTurn = vi.fn(async (_room: string, pid: string) => {
      order.push(`mark:${pid}`)
    })
    const turnFile = { path: 'b.ts', additions: 1, deletions: 0 }
    const earlier = { path: 'a.ts', additions: 3, deletions: 1 }
    const changes = vi.fn(async (_room: string, pid: string, scope?: 'turn' | 'all') =>
      pid !== 'p-a' ? [] : scope === 'all' ? [earlier, turnFile] : [turnFile]
    )
    const { fn } = scriptedStream(async (input) => {
      order.push(`speak:${nameOf(input)}`)
      return { text: 'done' }
    })
    await runRoom(
      'room-1',
      engineDeps(p, fn, {
        lookupProvider: providerLookup(toolProviders()),
        workspace: { ensure, changes, markTurn },
      }),
      signal()
    )
    expect(order.indexOf('mark:p-a')).toBeLessThan(order.indexOf('speak:Alice'))
    const alice = messagesOf(p).find(
      (m) => m.kind === 'speech' && m.author.kind === 'participant' && m.author.participantId === 'p-a'
    )!
    expect(alice.changes).toEqual({ files: [turnFile], workspace: 'C:/ws/p-a', cumulative: [earlier, turnFile] })
  })

  it('falls back to read-only and notes why when a workspace cannot be made', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', folder: 'C:/proj', participants: writers('full') }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Fix the bug.' }])
    const ensure = vi.fn(async () => {
      throw new Error('the folder is not trusted')
    })
    const { fn, calls } = scriptedStream(async () => ({ text: 'ok' }))
    await runRoom(
      'room-1',
      engineDeps(p, fn, {
        lookupProvider: providerLookup(toolProviders()),
        workspace: { ensure, changes: vi.fn(async () => []) },
      }),
      signal()
    )
    for (const c of calls) {
      expect(c.toolContext?.access).toBe('read')
      expect(c.toolContext?.folder).toBe('C:/proj')
    }
    expect(isolationNote('room-1')).toBe('the folder is not trusted')
  })

  it('without workspace support keeps the old read-only downgrade', async () => {
    const p = memoryPersistence()
    await seedRoom(p, makeRoom({ mode: 'compare', folder: 'C:/proj', participants: writers() }))
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Hi' }])
    const { fn, calls } = scriptedStream(async () => ({ text: 'ok' }))
    await runRoom('room-1', engineDeps(p, fn, { lookupProvider: providerLookup(toolProviders()) }), signal())
    expect(calls.every((c) => c.toolContext?.access === 'read')).toBe(true)
  })
})

describe('compare prompt with a workspace', () => {
  it('names the workspace as the working folder and keeps the access', async () => {
    const room = makeRoom({ mode: 'compare', folder: 'C:/proj', participants: writers() })
    const speaker = { kind: 'participant' as const, participant: room.participants[0] }
    const built = await buildPrompt({
      room,
      messages: [],
      speaker,
      contextWindow: 32_000,
      maxOutputTokens: 512,
      workspace: { path: 'C:/ws/p-a', source: 'C:/proj' },
    })
    expect(built.system).toContain('C:/ws/p-a')
    expect(built.system).toMatch(/write and edit/)
    const plain = await buildPrompt({ room, messages: [], speaker, contextWindow: 32_000, maxOutputTokens: 512 })
    expect(plain.system).not.toContain('isolated')
  })
})
