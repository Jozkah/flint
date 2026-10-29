import { describe, expect, it, vi } from 'vitest'
import { mapRemoteEvent } from '@/lib/remoteEventMapper'
import type { LiveEnvelope } from '@/lib/remoteRunner'
import type { CoworkTurn } from '@/types/coworkSession'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const env = (kind: string, payload: Record<string, unknown> = {}) =>
  ({ kind, payload }) as unknown as LiveEnvelope
const turns: CoworkTurn[] = []
const st = { turns, reattached: false }

describe('mapRemoteEvent', () => {
  it.each([
    [env('approval.resolved', { requestId: 'r1' }), { kind: 'approval-resolved', requestId: 'r1' }],
    [env('ask.answered', { requestId: 'a1' }), { kind: 'ask-resolved', requestId: 'a1', state: 'answered' }],
    [env('turn.completed', { x: 1 }), { kind: 'finish', payload: { x: 1 } }],
    [env('proposal.created', { p: 1 }), { kind: 'proposal-created', payload: { p: 1 } }],
    [env('proposal.error', { message: 'bad' }), { kind: 'proposal-error', message: 'bad' }],
    [env('worktree.changed'), { kind: 'worktree-changed' }],
    [env('worktree.discarded'), { kind: 'worktree-changed' }],
    [env('turn.started', { input: 'hi' }), { kind: 'none' }],
    [env('something.else'), { kind: 'none' }],
    [env('stream', { type: 'done', usage: { total_tokens: 3 } }), { kind: 'usage', usage: { total_tokens: 3 } }],
    [env('stream', { type: 'done' }), { kind: 'none' }],
    [env('stream', { type: 'error', message: 'boom' }), { kind: 'error', text: 'boom' }],
    [env('stream', { type: 'turn_usage' }), { kind: 'none' }],
    [env('stream', { type: 'ask_resolved', request_id: 'q' }), { kind: 'ask-resolved', requestId: 'q', state: 'cancelled' }],
    [env('stream', { type: 'ask_request', request_id: 'q', request: { questions: [] } }), { kind: 'ask', requestId: 'q', request: { questions: [] } }],
  ])('%#', (e, want) => {
    expect(mapRemoteEvent(e, st)).toEqual(want)
  })

  it('a reattached run with no turns takes the started input as the user turn', () => {
    expect(mapRemoteEvent(env('turn.started', { input: 'hi' }), { turns: [], reattached: true })).toEqual({
      kind: 'turns',
      turns: [{ role: 'user', content: 'hi' }],
    })
  })

  it('permission and subagent events pass the raw event through', () => {
    expect(mapRemoteEvent(env('stream', { type: 'permission_request', id: 1 }), st)).toMatchObject({
      kind: 'permission',
      raw: { type: 'permission_request', id: 1 },
    })
    for (const type of ['subagent_queued', 'subagent_start', 'subagent_title', 'subagent_end', 'subagent_finished', 'subagent'])
      expect(mapRemoteEvent(env('stream', { type }), st).kind).toBe('subagent')
  })

  it('an inner stream event that changes nothing maps to none', () => {
    expect(mapRemoteEvent(env('stream', { type: 'unknown_inner' }), st)).toEqual({ kind: 'none' })
  })
})
