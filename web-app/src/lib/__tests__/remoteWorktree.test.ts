import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useMessageQueue } from '@/stores/message-queue-store'
import { sendRemoteTurn, startRemoteSession } from '../remoteCowork'
import {
  commitWorktree,
  discardWorktree,
  listWorktrees,
  mergeWorktree,
  parseRunnerInfo,
  renameWorktree,
  worktreePending,
  worktreeState,
  worktreeUnmerged,
  type LiveEnvelope,
} from '../remoteRunner'
import { useRemoteWorktrees } from '../remoteWorktree'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))

const SID = '33333333-3333-4333-8333-333333333333'

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

type Call = { command: string; body: Record<string, unknown> }

/** A fetch that records each rpc and answers from `answers` by command. */
function recorder(answers: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const command = url.split('/').pop()!
    calls.push({ command, body: init?.body ? JSON.parse(String(init.body)) : {} })
    return json(answers[command] ?? {})
  }
  return { calls, fetchImpl }
}

const env = (seq: number, kind: string, payload: Record<string, unknown> = {}): LiveEnvelope => ({
  seq,
  source: 'live',
  kind,
  at: 0,
  payload,
})
const frame = (e: LiveEnvelope) => 'id: ' + e.seq + '\ndata: ' + JSON.stringify(e) + '\n\n'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await tick(5)
  }
}

beforeEach(() => {
  useCoworkSessions.setState({ sessions: [], currentId: null })
  useCoworkRun.setState({ liveTurns: {}, runs: {}, outcomes: {}, pendingAsks: {}, usage: {} })
  useToolApprovalRequests.setState({ pending: {}, queued: {} })
  useMessageQueue.setState({ queues: {} })
  useRemoteWorktrees.setState({ ticks: {}, proposals: {}, errors: {} })
})

describe('worktree wire client', () => {
  it('names the session and never a path, and reads the answers', async () => {
    const r = recorder({
      agent_worktree_pending: { files: ['a.txt', 7] },
      agent_worktree_unmerged: { commits: ['abc one'] },
      agent_worktree_list: { worktrees: [{ branch: 'flint/x' }] },
    })
    expect(await worktreePending(SID, r.fetchImpl)).toEqual(['a.txt'])
    expect(await worktreeUnmerged(SID, r.fetchImpl)).toEqual(['abc one'])
    expect(await listWorktrees('/srv/app', r.fetchImpl)).toHaveLength(1)
    await worktreeState(SID, r.fetchImpl)
    await commitWorktree(SID, 'msg', r.fetchImpl)
    await mergeWorktree(SID, { target: 'main' }, r.fetchImpl)
    await discardWorktree(SID, true, r.fetchImpl)
    await renameWorktree(SID, 'New title', r.fetchImpl)
    expect(r.calls.map((c) => c.command)).toEqual([
      'agent_worktree_pending',
      'agent_worktree_unmerged',
      'agent_worktree_list',
      'agent_worktree_state',
      'agent_worktree_commit_pending',
      'agent_worktree_merge',
      'agent_worktree_discard',
      'agent_worktree_rename',
    ])
    for (const call of r.calls.filter((c) => c.command !== 'agent_worktree_list')) {
      expect(call.body.id).toBe(SID)
      expect(Object.keys(call.body)).not.toContain('path')
      expect(Object.keys(call.body)).not.toContain('record')
    }
    expect(r.calls[5].body).toEqual({ id: SID, target: 'main' })
    expect(r.calls[6].body).toEqual({ id: SID, force: true })
  })

  it('reads the capability from an old and a new server', () => {
    expect(parseRunnerInfo({ agent: true }).runsWorktrees).toBe(false)
    expect(parseRunnerInfo({ runsWorktrees: true, runsChecks: true })).toMatchObject({
      runsWorktrees: true,
      runsChecks: true,
    })
  })

  it('lets a session opt out of isolation and otherwise leaves the choice to the server', async () => {
    const ready = { agent: true, runsSessions: true, enforces: true, roots: ['/srv'], missing: [] }
    const seen: Array<Record<string, unknown>> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.endsWith('agent_server_info')) return json(ready)
      seen.push(JSON.parse(String(init?.body)))
      return json({ id: SID, folder: '/srv/app', model: 'm', access: 'ask', status: 'idle', lastSeq: 0 })
    }
    await startRemoteSession({ folder: '/srv/app' }, fetchImpl)
    await startRemoteSession({ folder: '/srv/app', worktree: false }, fetchImpl)
    expect('worktree' in seen[0]).toBe(false)
    expect(seen[1].worktree).toBe(false)
  })
})

describe('server worktree events', () => {
  it('records a proposal and a refusal, and ticks the panel when a turn ends', async () => {
    useCoworkSessions.setState({
      sessions: [{ id: SID, title: 'S', folder: '/srv/app', turns: [], messages: [], updated: 1, remote: true }],
      currentId: SID,
    })
    const encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.includes('/events')) {
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      const command = url.split('/').pop()
      if (command === 'agent_run_start') return json({ turnId: 't1', after: 0 })
      if (command === 'agent_run_get') return json({ id: SID, title: 'S', folder: '/srv/app', turns: [] })
      void init
      return json({})
    }
    await sendRemoteTurn(SID, 'go', { fetchImpl, steerEveryMs: 20 })
    const before = useRemoteWorktrees.getState().ticks[SID] ?? 0
    controller.enqueue(
      encoder.encode(
        frame(env(1, 'turn.started', { turnId: 't1' })) +
          frame(env(2, 'proposal.created', { proposalId: 'p1', files: 2, additions: 5, deletions: 1 })) +
          frame(env(3, 'proposal.error', { message: 'leak.txt is a link' })) +
          frame(env(4, 'turn.completed', { turnId: 't1', stopReason: 'completed', error: null }))
      )
    )
    await until(() => !useCoworkRun.getState().runs[SID])
    const state = useRemoteWorktrees.getState()
    expect(state.proposals[SID]).toEqual({ proposalId: 'p1', files: 2, additions: 5, deletions: 1 })
    expect(state.errors[SID]).toBe('leak.txt is a link')
    expect(state.ticks[SID]).toBeGreaterThan(before)
    controller.close()
  })
})
