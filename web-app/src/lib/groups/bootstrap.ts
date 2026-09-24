import { getServiceHub } from '@/hooks/useServiceHub'
import {
  GROUPS_CHANGED_EVENT,
  configureGroups,
  handleGroupsChanged,
  useConversationGroups,
} from './store'
import type { GroupsChangedPayload } from './persistence'

let started = false

/** Loads every surface and wires cross-window change events. Idempotent. */
export async function initConversationGroups(): Promise<void> {
  if (started) return
  started = true
  try {
    const events = getServiceHub().events()
    configureGroups({ emit: (p) => events.emit(GROUPS_CHANGED_EVENT, p) })
    await events.listen<GroupsChangedPayload>(GROUPS_CHANGED_EVENT, (e) => handleGroupsChanged(e.payload))
  } catch (error) {
    console.error('Conversation groups: cross-window sync unavailable:', error)
  }
  await useConversationGroups.getState().loadAll()
}
