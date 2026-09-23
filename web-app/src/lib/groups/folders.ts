/**
 * Folder bindings for groups. Inspection resolves a canonical path and checks
 * reachability via metadata only; it never reads folder contents and never
 * grants access.
 */
import { getServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform/utils'
import { basename, canonicalKey } from './domain'
import type { GroupFolderBinding } from './types'

type InspectResult = { Ok?: InspectedFolder; Err?: string } | InspectedFolder | string
type InspectedFolder = {
  path: string
  canonicalPath: string
  displayName: string
  available: boolean
  kind: 'local' | 'unc' | 'link'
}

export type FolderInspection =
  | { ok: true; binding: GroupFolderBinding; kind: InspectedFolder['kind'] }
  | { ok: false; path: string; error: string }

/** Inspects paths via the backend; on web, bindings keep the picked path unverified. */
export async function inspectFolders(paths: string[]): Promise<FolderInspection[]> {
  if (!isPlatformTauri()) {
    return paths.map((path) => ({
      ok: true as const,
      kind: path.startsWith('\\\\') || path.startsWith('//') ? ('unc' as const) : ('local' as const),
      binding: { path, canonicalPath: path, displayName: basename(path) },
    }))
  }
  const results = await getServiceHub()
    .core()
    .invoke<InspectResult[]>('inspect_group_folders', { paths })
  return results.map((r, i) => {
    const value = typeof r === 'object' && r && 'Ok' in r ? r.Ok : typeof r === 'object' && r && !('Err' in r) ? (r as InspectedFolder) : undefined
    if (!value) {
      const error = typeof r === 'string' ? r : (r as { Err?: string })?.Err ?? 'Folder could not be inspected'
      return { ok: false as const, path: paths[i], error }
    }
    return {
      ok: true as const,
      kind: value.kind,
      binding: {
        path: value.path,
        canonicalPath: value.canonicalPath,
        displayName: value.displayName,
        available: value.available,
      },
    }
  })
}

/** A binding for a path the app already holds (an item's attached folder). */
export function folderBindingFor(path: string): GroupFolderBinding {
  return { path, canonicalPath: path, displayName: basename(path) }
}

/** Folders in `a` whose canonical key is not in `b`. */
export function foldersMissingFrom(a: readonly GroupFolderBinding[], b: readonly GroupFolderBinding[]) {
  const keys = new Set(b.map((x) => canonicalKey(x.canonicalPath)))
  return a.filter((x) => !keys.has(canonicalKey(x.canonicalPath)))
}

export function sameFolderSet(a: readonly GroupFolderBinding[], b: readonly GroupFolderBinding[]) {
  return foldersMissingFrom(a, b).length === 0 && foldersMissingFrom(b, a).length === 0
}
