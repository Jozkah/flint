import type {
  ModeratorConfig,
  Participant,
  ParticipantReasoning,
  Room,
  RoomLimits,
  RoomModelRef,
  RoomToolBudget,
  SpeakingMode,
  ToolAccess,
} from '@/lib/rooms/types'
import { compareRunOf, type CompareRun } from '@/lib/rooms/types'
import type { WorkProfileId } from '@/lib/workProfiles'

/**
 * What the room editor holds while someone is typing: every setting as the
 * text or choice in its field, plus a draft per participant. `roomDraftReducer`
 * is the only thing that changes it, so each way a draft changes is one named
 * action rather than a setter scattered through the component.
 */

export const LIMIT_KEYS: (keyof RoomLimits)[] = [
  'maxRounds',
  'maxTurns',
  'maxConsecutivePerParticipant',
  'maxTotalTokens',
  'maxOutputTokensPerTurn',
  'maxDurationMs',
  'maxRepetitiveTurns',
  'repetitionSimilarity',
  'maxCostUsd',
]

export const MINUTE_MS = 60_000

export type LimitDraft = Record<keyof RoomLimits, string>

/** Limits are edited as text; duration is shown in minutes. */
export function toLimitDraft(l: RoomLimits): LimitDraft {
  const out = {} as LimitDraft
  for (const key of LIMIT_KEYS) {
    const v = l[key]
    out[key] =
      v === null ? '' : key === 'maxDurationMs' ? String(Math.round((v as number) / MINUTE_MS)) : String(v)
  }
  return out
}

export type BudgetKey = 'maxToolCalls' | 'maxSteps' | 'toolTimeoutSec'
export const BUDGET_KEYS: BudgetKey[] = ['maxToolCalls', 'maxSteps', 'toolTimeoutSec']
export type BudgetDraft = Record<BudgetKey, string>

export const toBudgetDraft = (b: RoomToolBudget | undefined): BudgetDraft => ({
  maxToolCalls: b?.maxToolCalls != null ? String(b.maxToolCalls) : '',
  maxSteps: b?.maxSteps != null ? String(b.maxSteps) : '',
  toolTimeoutSec: b?.toolTimeoutSec != null ? String(b.toolTimeoutSec) : '',
})

export const budgetFromDraft = (d: BudgetDraft): RoomToolBudget | null => {
  const out: RoomToolBudget = {}
  for (const k of BUDGET_KEYS) {
    const n = Number(d[k])
    if (d[k].trim() !== '' && Number.isFinite(n)) out[k] = n
  }
  return Object.keys(out).length ? out : null
}

export type DraftParticipant = {
  id: string
  name: string
  role: string
  model: RoomModelRef
  toolAccess: ToolAccess
  priceIn: string
  priceOut: string
  reasoning?: ParticipantReasoning
  assistantId?: string
  workProfile?: WorkProfileId
  disabledTools: string[]
  source: Participant
}

export const toDraftParticipant = (p: Participant): DraftParticipant => ({
  id: p.id,
  name: p.name,
  role: p.role,
  model: p.model,
  toolAccess: p.toolAccess,
  priceIn: p.pricing ? String(p.pricing.inputPerMTokUsd) : '',
  priceOut: p.pricing ? String(p.pricing.outputPerMTokUsd) : '',
  reasoning: p.reasoning,
  assistantId: p.assistantId,
  workProfile: p.workProfile,
  disabledTools: p.disabledTools ?? [],
  source: p,
})

export function parsePricing(d: Pick<DraftParticipant, 'priceIn' | 'priceOut'>) {
  const i = Number(d.priceIn)
  const o = Number(d.priceOut)
  if (d.priceIn.trim() === '' || d.priceOut.trim() === '') return undefined
  if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) return undefined
  return { inputPerMTokUsd: i, outputPerMTokUsd: o }
}

export type RoomDraft = {
  title: string
  objective: string
  mode: SpeakingMode
  compareRun: CompareRun
  /** The room-wide effort ("same for all"); null: each model's default. */
  reasoningEffort: NonNullable<Room['reasoningEffort']> | null
  moderator: ModeratorConfig
  limits: LimitDraft
  budget: BudgetDraft
  participants: DraftParticipant[]
}

/** The fields edited one value at a time. */
export type DraftField = Exclude<keyof RoomDraft, 'participants'>

export type RoomDraftAction =
  /** One field changed by the person editing. */
  | { type: 'edit'; field: DraftField; value: RoomDraft[DraftField] }
  /** One participant's draft changed by the person editing. */
  | { type: 'updateParticipant'; id: string; patch: Partial<DraftParticipant> }
  /** Nothing is being edited: take the room as it is now. */
  | { type: 'reset'; room: Room; participants: Participant[] }
  /**
   * A new revision arrived while the draft has edits: keep them, but take the
   * new revision's participant as each draft's source (availability stays
   * current), drop participants that left and add the ones that joined.
   */
  | { type: 'syncParticipants'; participants: Participant[] }

/** The draft a room starts from. `participants` are the room's active ones. */
export function draftFromRoom(room: Room, participants: Participant[]): RoomDraft {
  return {
    title: room.title,
    objective: room.objective,
    mode: room.mode,
    compareRun: compareRunOf(room),
    reasoningEffort: room.reasoningEffort ?? null,
    moderator: room.moderator,
    limits: toLimitDraft(room.limits),
    budget: toBudgetDraft(room.toolBudget),
    participants: participants.map(toDraftParticipant),
  }
}

export function roomDraftReducer(draft: RoomDraft, action: RoomDraftAction): RoomDraft {
  switch (action.type) {
    case 'edit':
      return { ...draft, [action.field]: action.value }
    case 'updateParticipant':
      return {
        ...draft,
        participants: draft.participants.map((p) =>
          p.id === action.id ? { ...p, ...action.patch } : p
        ),
      }
    case 'reset':
      return draftFromRoom(action.room, action.participants)
    case 'syncParticipants': {
      const fresh = action.participants.map(toDraftParticipant)
      const kept = draft.participants.flatMap((d) => {
        const f = fresh.find((x) => x.id === d.id)
        return f ? [{ ...d, source: f.source }] : []
      })
      const added = fresh.filter((f) => !draft.participants.some((d) => d.id === f.id))
      return { ...draft, participants: [...kept, ...added] }
    }
  }
}
