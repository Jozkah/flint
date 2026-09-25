import { invoke } from '@/lib/previewInvoke'
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

/**
 * Replace an item's ENTIRE surface list in one shot (the full-vector
 * counterpart to `setMatrix`'s single-cell toggle), for grid UIs where one
 * checkbox click recomputes the whole boolean vector. `surfaces: null`
 * clears the item back to its default (enabled everywhere).
 */
export const setItemSurfaces = (
  kind: ExtensionKind,
  id: string,
  surfaces: string[] | null
) =>
  call<ExtensionsMatrix>('agent_extensions_matrix_set_item', {
    kind,
    id,
    surfaces,
  })

export const listProjects = () => call<ProjectEntry[]>('agent_projects_list', {})

export const registerProject = (folder: string) =>
  call<ProjectEntry>('agent_projects_register', { folder })

/** One skill or plugin found on disk by a Claude Code import scan. */
export interface CcItem {
  kind: ExtensionKind
  name: string
  sourcePath: string
  origin: string
  alreadyExists: boolean
}

export interface CcScan {
  items: CcItem[]
}

/**
 * The subset of a `CcItem` sent back to `agent_cc_import`. `sourcePath` must
 * always come from a prior scan result -- never a user-typed path -- since the
 * backend trusts it as a filesystem location to copy from.
 */
export type CcImportSelection = Pick<CcItem, 'kind' | 'name' | 'sourcePath'>

export interface CcImportResult {
  imported: string[]
  skipped: string[]
  errors: string[]
}

/** Scan `root` (or the backend's default) for importable Claude Code skills/plugins. */
export const ccScan = (root?: string) =>
  call<CcScan>('agent_cc_scan', root ? { root } : {})

/** Import the selected scan items, optionally overwriting existing ones. */
export const ccImport = (items: CcImportSelection[], overwrite: boolean) =>
  call<CcImportResult>('agent_cc_import', { items, overwrite })
