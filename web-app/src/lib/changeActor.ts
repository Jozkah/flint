/**
 * Reading an agent's identity off a change (AH-110).
 *
 * The journal keeps the identity (`agent`, `agent:<name>`, `role:<name>`) and a
 * label that may be renamed later. Surfaces show the label; they say what kind
 * of agent it was from the identity, so a role never reads as a named agent and
 * a renamed agent never rewrites who made an old change. A change with no actor
 * -- one recorded before provenance existed -- is unknown, never the agent
 * running now.
 */
import type { ChangeActor } from '@janhq/tauri-plugin-agent-tools-api'

export type ActorLabelParts =
  | { kind: 'primary' }
  | { kind: 'named'; name: string }
  | { kind: 'role'; name: string }
  | { kind: 'user' }
  | { kind: 'unknown' }

/** What to say about an actor, before translation. */
export function actorLabelParts(actor?: ChangeActor | null): ActorLabelParts {
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim()) {
    return { kind: 'unknown' }
  }
  // A hand edit from the Code panel: the person, never an agent.
  if (actor.kind === 'user' || actor.id === 'user') return { kind: 'user' }
  const name = (actor.label || '').trim()
  if (actor.kind === 'role') {
    return { kind: 'role', name: name || actor.id.replace(/^role:/, '') }
  }
  if (actor.kind === 'named') {
    return { kind: 'named', name: name || actor.id.replace(/^agent:/, '') }
  }
  return { kind: 'primary' }
}

/**
 * The whole "Changed by ..." sentence, given a translator. One string so a
 * screen reader and the visible row say exactly the same thing, and so the
 * information never depends on colour.
 */
export function changedByText(
  actor: ChangeActor | null | undefined,
  t: (key: string, vars?: Record<string, unknown>) => string
): string {
  const parts = actorLabelParts(actor)
  const who =
    parts.kind === 'primary'
      ? t('common:turnUndo.primaryAgent')
      : parts.kind === 'named'
        ? t('common:turnUndo.namedAgent', { name: parts.name })
        : parts.kind === 'role'
          ? t('common:turnUndo.roleAgent', { name: parts.name })
          : parts.kind === 'user'
            ? t('common:turnUndo.user')
            : t('common:turnUndo.unknownAgent')
  return t('common:turnUndo.changedBy', { who })
}

/**
 * The actor an execution-record row describes, from the identity and the
 * display name the event carried. A row with neither is unknown.
 */
export function actorFromEvent(
  agentId?: string | null,
  agent?: string | null
): ChangeActor | null {
  const id = (agentId || '').trim()
  const name = (agent || '').trim()
  if (!id && !name) return null
  if (!id) {
    // Older rows carry the display name only: it still says who, and the kind
    // is read from the name rather than invented.
    return name === 'main'
      ? { id: 'agent', kind: 'primary', label: '' }
      : { id: `agent:${name}`, kind: 'named', label: name }
  }
  if (id === 'user') return { id, kind: 'user', label: '' }
  const kind: ChangeActor['kind'] = id.startsWith('role:')
    ? 'role'
    : id === 'agent'
      ? 'primary'
      : 'named'
  return { id, kind, label: name && name !== 'main' ? name : '' }
}

/** The actors of one turn, in order, including the unknown one when present. */
export function turnActors(turn: {
  actors?: ChangeActor[]
  changes?: { path: string; actor?: ChangeActor }[]
}): (ChangeActor | null)[] {
  const known = Array.isArray(turn.actors) ? turn.actors : []
  const anyUnknown = Array.isArray(turn.changes)
    ? turn.changes.some((c) => !c.actor)
    : known.length === 0
  return anyUnknown ? [...known, null] : known
}
