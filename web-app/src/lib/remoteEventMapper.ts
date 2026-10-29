/**
 * The remote Cowork run's event mapping: what one server envelope means for
 * the run, as data. RemoteRun (remoteCowork.ts) applies the effect.
 */
import { applyInnerToTurns, type StreamEvent } from '@/hooks/useCoworkRun'
import type { LiveEnvelope } from '@/lib/remoteRunner'
import type { CoworkTurn, Usage } from '@/types/coworkSession'

/** What one server event means for a remote run; `applyRemoteEffect` does it. */
export type RemoteEffect =
  | { kind: 'none' }
  | { kind: 'turns'; turns: CoworkTurn[] }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'error'; text: string }
  | { kind: 'permission'; raw: Record<string, unknown> }
  | { kind: 'ask'; requestId: string; request: { questions: unknown[] } }
  | { kind: 'ask-resolved'; requestId: string; state: 'answered' | 'cancelled' }
  | { kind: 'subagent'; event: StreamEvent }
  | { kind: 'approval-resolved'; requestId: string }
  | { kind: 'finish'; payload: Record<string, unknown> }
  | { kind: 'proposal-created'; payload: Record<string, unknown> }
  | { kind: 'proposal-error'; message: string }
  | { kind: 'worktree-changed' }

/**
 * Map one envelope from the server to what the run should do with it. Pure:
 * reads the run's turns, never writes them or a store.
 */
export function mapRemoteEvent(
  env: LiveEnvelope,
  state: { turns: CoworkTurn[]; reattached: boolean }
): RemoteEffect {
  const payload = (env.payload ?? {}) as Record<string, unknown>
  switch (env.kind) {
    case 'stream':
      return mapStreamEvent(payload as unknown as StreamEvent & Record<string, unknown>, state.turns)
    case 'turn.started':
      if (state.reattached && state.turns.length === 0 && typeof payload.input === 'string') {
        return { kind: 'turns', turns: [{ role: 'user', content: payload.input }] }
      }
      return { kind: 'none' }
    case 'approval.resolved':
      return { kind: 'approval-resolved', requestId: String(payload.requestId ?? '') }
    case 'ask.answered':
      return { kind: 'ask-resolved', requestId: String(payload.requestId ?? ''), state: 'answered' }
    case 'turn.completed':
      return { kind: 'finish', payload }
    case 'proposal.created':
      return { kind: 'proposal-created', payload }
    case 'proposal.error':
      return { kind: 'proposal-error', message: String(payload.message ?? '') }
    case 'worktree.changed':
    case 'worktree.discarded':
      return { kind: 'worktree-changed' }
    default:
      return { kind: 'none' }
  }
}

function mapStreamEvent(
  ev: StreamEvent & Record<string, unknown>,
  turns: CoworkTurn[]
): RemoteEffect {
  // The server also sends events the local loop never had (permission and
  // question bookkeeping), so the tag is read as a plain string.
  const raw = ev as Record<string, unknown>
  switch (raw.type as string) {
    case 'done': {
      const usage = raw.usage as Usage | null | undefined
      return usage ? { kind: 'usage', usage } : { kind: 'none' }
    }
    case 'error':
      return { kind: 'error', text: String(raw.message ?? '') }
    case 'turn_usage':
      return { kind: 'none' }
    case 'permission_request':
      return { kind: 'permission', raw }
    case 'ask_request':
      return {
        kind: 'ask',
        requestId: String(raw.request_id),
        request: raw.request as { questions: unknown[] },
      }
    case 'ask_resolved':
      return { kind: 'ask-resolved', requestId: String(raw.request_id ?? ''), state: 'cancelled' }
    case 'subagent_queued':
    case 'subagent_start':
    case 'subagent_title':
    case 'subagent_end':
    case 'subagent_finished':
    case 'subagent':
      return { kind: 'subagent', event: ev }
    default: {
      const next = applyInnerToTurns(turns, ev)
      return next !== turns ? { kind: 'turns', turns: next } : { kind: 'none' }
    }
  }
}
