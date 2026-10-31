/**
 * Pure room-editor helpers: participant, moderator, tool-list, budget and
 * folder normalisation. The controller applies them; nothing here touches
 * the store, persistence or a run.
 */
import { isWorkProfileId } from '@/lib/workProfiles'
import { isEffortLevel, type EffortLevel } from '@/lib/modelEffort'
import { modelToolSupport, type ProviderLookup } from './availability'
import { normaliseParticipantReasoning } from './participantReasoning'
import { ROOM_TOOL_BUDGET_CEILINGS } from './toolBudget'
import {
  ROOM_LIMIT_CEILINGS,
  type ModeratorConfig,
  type Participant,
  type RoomError,
  type RoomToolBudget,
  type ToolAccess,
} from './types'
import type { ParticipantInput } from './controller'

export function roomError(code: RoomError['code'], message: string): RoomError {
  return { code, message }
}

/** A tool-name list from the editor: strings only, trimmed, no repeats, capped. */
export function cleanDisabledTools(list: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const v of list) {
    if (typeof v !== 'string') continue
    const t = v.trim().slice(0, 128)
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= 256) break
  }
  return out
}

/** The room-wide effort: a known level, else none (each model's default). */
export function roomEffortField(value: unknown): EffortLevel | undefined {
  return isEffortLevel(value) ? value : undefined
}

/** The stored tool budget: only the fields set, clamped; none means defaults. */
export function budgetField(budget: RoomToolBudget | null | undefined): { toolBudget: RoomToolBudget | undefined } {
  if (!budget) return { toolBudget: undefined }
  const c = ROOM_TOOL_BUDGET_CEILINGS
  const one = (v: unknown, ceiling: number) => {
    const n = Number(v)
    return v == null || v === '' || !Number.isFinite(n) ? undefined : Math.max(1, Math.min(ceiling, Math.floor(n)))
  }
  const out: RoomToolBudget = {}
  const calls = one(budget.maxToolCalls, c.maxToolCalls)
  const steps = one(budget.maxSteps, c.maxSteps)
  const timeout = one(budget.toolTimeoutSec, c.toolTimeoutSec)
  if (calls !== undefined) out.maxToolCalls = calls
  if (steps !== undefined) out.maxSteps = steps
  if (timeout !== undefined) out.toolTimeoutSec = timeout
  return { toolBudget: Object.keys(out).length ? out : undefined }
}

/** Most folders a room may have beside its main one. */
export const MAX_EXTRA_FOLDERS = 8

/** The extra folders as stored: trimmed, no repeats, none that is the main one, capped. */
export function cleanExtraFolders(
  folders: readonly string[],
  main: string | null
): string[] {
  const out: string[] = []
  for (const raw of folders) {
    const f = typeof raw === 'string' ? raw.trim() : ''
    if (f && f !== main && !out.includes(f)) out.push(f)
  }
  return out.slice(0, MAX_EXTRA_FOLDERS)
}

export function normaliseParticipant(
  input: ParticipantInput & { id?: string; order: number; removed?: boolean },
  deps: { newId: () => string; lookup: ProviderLookup }
): Participant {
  const name = input.name.trim()
  if (!name) throw roomError('invalid_room', 'A participant needs a name.')
  // A new participant (no toolAccess given) defaults to read-only, so a
  // tool-capable model can use tools the moment the room has a folder or a
  // trusted MCP server -- without that default, every room silently started
  // tool-less and users hit "I have no tools". An explicit 'none' is still
  // honoured. 'read'/'edit' both need a tool-capable model, and any choice is
  // dropped to 'none' when the model has no tools.
  const requested: ToolAccess = input.toolAccess ?? 'read'
  const wantsTools = requested === 'read' || requested === 'edit' || requested === 'full'
  const reasoning = normaliseParticipantReasoning(input.reasoning)
  let pricing: Participant['pricing']
  if (input.pricing) {
    const i = Number(input.pricing.inputPerMTokUsd)
    const o = Number(input.pricing.outputPerMTokUsd)
    if (Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0) {
      pricing = { inputPerMTokUsd: i, outputPerMTokUsd: o }
    }
  }
  return {
    id: input.id ?? deps.newId(),
    name: name.slice(0, 80),
    role: (input.role ?? '').trim().slice(0, 200),
    model: { provider: input.model.provider, id: input.model.id },
    // Forced to none only when the model resolves and truly lacks tools; an
    // unresolved model (provider not loaded yet) keeps the requested access
    // rather than being silently and permanently downgraded. The engine gates
    // tools again at run time, when the model is resolvable.
    toolAccess:
      wantsTools && modelToolSupport(input.model, deps.lookup) !== 'no'
        ? (requested as 'read' | 'edit' | 'full')
        : 'none',
    removed: input.removed ?? false,
    order: input.order,
    availability: { state: 'unknown' },
    ...(pricing ? { pricing } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(input.assistantId?.trim() ? { assistantId: input.assistantId.trim() } : {}),
    ...(isWorkProfileId(input.workProfile) ? { workProfile: input.workProfile } : {}),
  }
}

export function validateParticipants(participants: Participant[]): void {
  if (participants.length > ROOM_LIMIT_CEILINGS.maxParticipants) {
    throw roomError(
      'invalid_room',
      `A room can have at most ${ROOM_LIMIT_CEILINGS.maxParticipants} participants.`
    )
  }
  const seen = new Set<string>()
  for (const p of participants) {
    if (p.removed) continue
    const key = p.name.toLowerCase()
    if (seen.has(key)) {
      throw roomError('invalid_room', `Participant names must be unique ("${p.name}").`)
    }
    seen.add(key)
  }
}

export const normaliseModerator = (
  m: Partial<ModeratorConfig> | undefined,
  prev?: ModeratorConfig
): ModeratorConfig => ({
  enabled: m?.enabled ?? prev?.enabled ?? false,
  name: (m?.name ?? prev?.name ?? 'Moderator').trim().slice(0, 80) || 'Moderator',
  model:
    m?.model === undefined
      ? (prev?.model ?? null)
      : m.model && typeof m.model.provider === 'string' && typeof m.model.id === 'string'
        ? { provider: m.model.provider, id: m.model.id }
        : null,
})
