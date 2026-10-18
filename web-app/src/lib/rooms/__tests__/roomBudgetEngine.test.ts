import { describe, it, expect, vi } from 'vitest'
import { runRoom } from '../engine'
import {
  engineDeps,
  makeRoom,
  memoryPersistence,
  messagesOf,
  participant,
  scriptedStream,
  seedMessages,
  seedRoom,
} from './helpers'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))

describe('room tool budget in the engine', () => {
  it('passes the budget and picker to the turn and records a budget hit', async () => {
    const p = memoryPersistence()
    await seedRoom(
      p,
      makeRoom({
        toolBudget: { maxToolCalls: 2, maxSteps: 4, toolTimeoutSec: 9 },
        limits: { maxTurns: 1 },
        participants: [
          participant('p-a', 'Alice', 'provider-a', 'model-1', { order: 0, toolAccess: 'read', disabledTools: ['web_fetch'] }),
          participant('p-b', 'Bob', 'provider-b', 'model-2', { order: 1 }),
        ],
      })
    )
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Go' }])
    const { fn, calls } = scriptedStream(async () => ({ text: 'done' }))
    const wrapped = async (input: Parameters<typeof fn>[0]) => ({ ...(await fn(input)), budgetHit: 'tool-calls' as const })
    await runRoom('room-1', engineDeps(p, wrapped), new AbortController().signal)
    expect(calls[0].toolContext?.budget).toEqual({ maxToolCalls: 2, maxSteps: 4, toolTimeoutSec: 9 })
    expect(calls[0].toolContext?.disabledTools).toEqual(['web_fetch'])
    const speech = messagesOf(p).find((m) => m.kind === 'speech')!
    expect(speech.budgetHit).toBe('tool-calls')
  })

  it('keeps why a turn stopped, and its thinking only when it wrote nothing', async () => {
    const p = memoryPersistence()
    await seedRoom(
      p,
      makeRoom({
        limits: { maxTurns: 2 },
        participants: [
          participant('p-a', 'Alice', 'provider-a', 'model-1', { order: 0 }),
          participant('p-b', 'Bob', 'provider-b', 'model-2', { order: 1 }),
        ],
      })
    )
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Go' }])
    let n = 0
    const { fn } = scriptedStream(async () => ({ text: n++ === 0 ? '' : 'answer' }))
    const wrapped = async (input: Parameters<typeof fn>[0]) => ({
      ...(await fn(input)),
      finishReason: 'length',
      reasoning: 'thinking hard',
    })
    await runRoom('room-1', engineDeps(p, wrapped), new AbortController().signal)
    const [blank, answered] = messagesOf(p).filter((m) => m.kind === 'speech')
    expect(blank.finishReason).toBe('length')
    expect(blank.reasoning).toBe('thinking hard')
    expect(answered.finishReason).toBe('length')
    expect(answered.reasoning).toBeUndefined()
  })

  it('records the files a turn in the shared folder wrote', async () => {
    const p = memoryPersistence()
    await seedRoom(
      p,
      makeRoom({
        folder: 'C:/proj',
        limits: { maxTurns: 1 },
        participants: [
          participant('p-a', 'Alice', 'provider-a', 'model-1', { order: 0, toolAccess: 'edit' }),
          participant('p-b', 'Bob', 'provider-b', 'model-2', { order: 1 }),
        ],
      })
    )
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Go' }])
    const { fn } = scriptedStream(async () => ({ text: 'done' }))
    const wrapped = async (input: Parameters<typeof fn>[0]) => ({
      ...(await fn(input)),
      toolActivity: [{ name: 'write', ok: true, args: { path: 'C:/proj/a.md', content: 'hi\n' } }],
    })
    await runRoom('room-1', engineDeps(p, wrapped), new AbortController().signal)
    const speech = messagesOf(p).find((m) => m.kind === 'speech')!
    expect(speech.changes?.files.map((f) => [f.path, f.additions])).toEqual([['C:/proj/a.md', 1]])
    expect(speech.changes?.workspace).toBeUndefined()
  })

  it('a pause, and only a pause, holds approvals', async () => {
    const p = memoryPersistence()
    await seedRoom(
      p,
      makeRoom({
        limits: { maxTurns: 1 },
        participants: [
          participant('p-a', 'Alice', 'provider-a', 'model-1', { order: 0, toolAccess: 'read' }),
          participant('p-b', 'Bob', 'provider-b', 'model-2', { order: 1 }),
        ],
      })
    )
    await seedMessages(p, 'room-1', [{ author: { kind: 'user' }, text: 'Go' }])
    const ctrl = new AbortController()
    let intent: 'pause' | 'stop' = 'pause'
    const labels: Array<string | null> = []
    const { fn } = scriptedStream(async (input) => {
      labels.push(input.toolContext?.holdLabel?.() ?? null)
      ctrl.abort()
      labels.push(input.toolContext?.holdLabel?.() ?? null)
      intent = 'stop'
      labels.push(input.toolContext?.holdLabel?.() ?? null)
      return { text: 'x' }
    })
    await runRoom('room-1', engineDeps(p, fn), ctrl.signal, { intent: () => intent }).catch(() => {})
    expect(labels).toEqual([null, 'room paused', null])
  })
})
