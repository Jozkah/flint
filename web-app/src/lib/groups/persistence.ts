/**
 * Storage for conversation groups. Each surface is its own key in the Rust
 * settings store (atomic temp-file-and-rename write), so a write for one
 * surface can never clobber another surface's groups, even when two windows
 * hold different snapshots. Unlike `backendStorage.setItem`, `saveSurface`
 * rethrows, so callers can roll back optimistic updates on failure.
 */
import { isPlatformTauri } from '@/lib/platform/utils'
import { getServiceHub } from '@/hooks/useServiceHub'
import { localStorageKey } from '@/constants/localStorage'
import { GROUPS_SCHEMA_VERSION, type GroupSurface, type SurfaceGroups } from './types'

export const surfaceKey = (surface: GroupSurface) =>
  `${localStorageKey.conversationGroups}:${surface}`

/** On-disk envelope. `migratedProjects` marks the one-time Home projects import. */
export type SurfaceEnvelope = {
  version: number
  data: SurfaceGroups
  migratedProjects?: boolean
}

export interface GroupsPort {
  load(surface: GroupSurface): Promise<string | null>
  save(surface: GroupSurface, raw: string): Promise<void>
}

export const settingsGroupsPort: GroupsPort = {
  async load(surface) {
    const key = surfaceKey(surface)
    if (!isPlatformTauri()) return localStorage.getItem(key)
    return (
      (await getServiceHub().core().invoke<string | null>('settings_get', { key })) ?? null
    )
  },
  async save(surface, raw) {
    const key = surfaceKey(surface)
    if (!isPlatformTauri()) {
      localStorage.setItem(key, raw)
      return
    }
    await getServiceHub().core().invoke('settings_set', { key, value: raw })
  },
}

export function encodeSurface(data: SurfaceGroups, migratedProjects: boolean): string {
  const envelope: SurfaceEnvelope = {
    version: GROUPS_SCHEMA_VERSION,
    data,
    ...(migratedProjects ? { migratedProjects } : {}),
  }
  return JSON.stringify(envelope)
}

/**
 * Parses a stored envelope. Returns null when nothing usable is stored; the
 * caller then starts from an empty surface and every item shows in Recents.
 * A future version is read best-effort rather than discarded.
 */
export function decodeSurface(raw: string | null): { data: unknown; migratedProjects: boolean } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<SurfaceEnvelope>
    if (!parsed || typeof parsed !== 'object') return null
    return { data: parsed.data, migratedProjects: parsed.migratedProjects === true }
  } catch {
    return null
  }
}

/** Cross-window notification: the named surface changed on disk. */
export const GROUPS_CHANGED_EVENT = 'conversation-groups-changed'
export type GroupsChangedPayload = { surface: GroupSurface; origin: string }
