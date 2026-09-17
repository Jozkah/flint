import { invoke } from '@tauri-apps/api/core'
import type { SkillMeta } from '@/lib/skillStore'

export type { SkillMeta }

/**
 * Where an extension (skill or plugin) is being resolved or toggled for:
 * the home surface, the rooms surface, or a specific cowork project.
 */
export type Surface = 'home' | 'rooms' | { cowork: string }

export interface ProjectEntry {
  id: string
  folder: string
  name: string
}

export interface ExtensionsMatrix {
  skills: Record<string, { surfaces: string[] }>
  plugins: Record<string, { surfaces: string[] }>
}

export type ExtensionKind = 'skill' | 'plugin'

/** Normalize a `Surface` into the args shape the Tauri commands expect. */
function surfaceArgs(surface: Surface): Record<string, unknown> {
  if (typeof surface === 'string') return { surface }
  return { surface: 'cowork', projectId: surface.cowork }
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return await invoke<T>(command, args)
}

export const resolveExtensions = (surface: Surface) =>
  call<SkillMeta[]>('agent_resolve_extensions', surfaceArgs(surface))

export const getMatrix = () => call<ExtensionsMatrix>('agent_extensions_matrix_get', {})

export const setMatrix = (
  kind: ExtensionKind,
  id: string,
  surface: Surface,
  enabled: boolean
) =>
  call<ExtensionsMatrix>('agent_extensions_matrix_set', {
    kind,
    id,
    ...surfaceArgs(surface),
    enabled,
  })

export const listProjects = () => call<ProjectEntry[]>('agent_projects_list', {})

export const registerProject = (folder: string) =>
  call<ProjectEntry>('agent_projects_register', { folder })
