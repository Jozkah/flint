import { promptReplaceModels } from '@/hooks/useModelReplacePrompt'
import { modelKey, unavailableModels, type ModelRef } from '@/lib/modelReplace'
import type { Participant, Room } from './types'

type Patch = {
  /** Every participant, the ones with a missing model carrying its replacement. */
  participants?: Participant[]
  moderator?: Room['moderator']
}

/** The models a room needs to run: its speaking participants and its moderator. */
export function roomModelRefs(room: Room): (ModelRef | null)[] {
  return [
    ...room.participants.filter((p) => !p.removed).map((p) => p.model),
    ...(room.moderator.enabled ? [room.moderator.model] : []),
  ]
}

/**
 * Before a room starts or resumes: if a model it needs is gone, ask the user for
 * another and return the settings that swap it in. `null` means they cancelled,
 * so the room should not start; an empty patch means nothing was missing.
 */
export async function replaceMissingRoomModels(
  room: Room,
  lookup?: Parameters<typeof unavailableModels>[1]
): Promise<Patch | null> {
  const missing = unavailableModels(roomModelRefs(room), lookup)
  if (missing.length === 0) return {}
  const choices = await promptReplaceModels(room.title || 'This room', missing)
  if (!choices) return null
  const swap = (ref: ModelRef) => choices[modelKey(ref)] ?? ref
  const modModel = room.moderator.model
  return {
    participants: room.participants.map((p) =>
      !p.removed && choices[modelKey(p.model)] ? { ...p, model: swap(p.model) } : p
    ),
    ...(room.moderator.enabled && modModel && choices[modelKey(modModel)]
      ? { moderator: { ...room.moderator, model: swap(modModel) } }
      : {}),
  }
}
