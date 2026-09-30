import { toolActivityText } from '@/lib/agentActivity'
import type { LiveTurn } from './types'

export type LiveStatus =
  | { kind: 'compacting' }
  | { kind: 'approval'; tool: string }
  | { kind: 'tool'; text: string }
  | { kind: 'writing' }
  | { kind: 'thinking' }

/**
 * What a participant is doing right now, for the live turn's header: waiting on
 * the user's approval, running a tool, writing its reply, or (before anything has
 * arrived) thinking.
 */
export function liveStatus(live: LiveTurn, approvalTool: string | null): LiveStatus {
  if (live.compacting) return { kind: 'compacting' }
  if (approvalTool) return { kind: 'approval', tool: approvalTool }
  if (live.activity) {
    return { kind: 'tool', text: toolActivityText(live.activity.name, live.activity.args) }
  }
  if (live.text.trim()) return { kind: 'writing' }
  return { kind: 'thinking' }
}
