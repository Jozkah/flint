/**
 * The `@` menu's one ranked list: files and folders in the attached folder,
 * skills, saved agents and aliases. AH-204.
 *
 * Every entry carries the token it inserts. A file inserts its path relative
 * to the folder; the others insert a typed reference (`skill:name`,
 * `agent:name`, `alias:name`). What is inserted is the identifier, never the
 * label shown, so the reference means the same thing however it is displayed.
 *
 * Files arrive already confined: they come from the backend's listing of the
 * attached folder. Nothing here can offer a path outside it.
 */
import type { FilePickerEntry } from '@/types/path-reference'
import type { ReferenceAlias } from '@/lib/referenceAliases'
import { typedReference, type TypedReferenceKind } from '@/lib/path-references'

export type ReferenceKind = 'file' | 'directory' | TypedReferenceKind

export type ReferenceEntry = {
  kind: ReferenceKind
  /** Inserted after `@`. */
  token: string
  /** What the row is called. */
  name: string
  /** A second line: a path, a description, what an alias names. */
  detail?: string
  extension?: string
}

export type NamedSource = { name: string; description?: string }

/** The id of option `index` in the list `listId`, for `aria-activedescendant`. */
export const optionId = (listId: string, index: number) =>
  `${listId}-option-${index}`

export type ReferenceSources = {
  files: FilePickerEntry[]
  skills: NamedSource[]
  agents: NamedSource[]
  aliases: ReferenceAlias[]
}

/** Ties go to the entry most likely meant: a name the user gave, then tools. */
const KIND_ORDER: Record<ReferenceKind, number> = {
  alias: 0,
  skill: 1,
  agent: 2,
  directory: 3,
  file: 4,
}

function score(q: string, name: string, detail = ''): number {
  if (!q) return 10
  const n = name.toLowerCase()
  if (n === q) return 100
  if (n.startsWith(q)) return 80
  if (n.includes(q)) return 60
  if (detail.toLowerCase().includes(q)) return 40
  return 0
}

/**
 * Rank everything the `@` menu can offer for `query`, as one list.
 *
 * A query that starts with a kind (`skill:rev`) offers only that kind. A
 * source that failed to load is simply empty: the rest still rank, and
 * typing is never blocked on an index.
 */
export function rankReferences(
  query: string,
  sources: ReferenceSources,
  limit = 50
): ReferenceEntry[] {
  let q = query.trim().toLowerCase()
  let only: ReferenceKind | null = null
  const prefixed = /^(skill|agent|alias):(.*)$/.exec(q)
  if (prefixed) {
    only = prefixed[1] as ReferenceKind
    q = prefixed[2]
  }
  const candidates: ReferenceEntry[] = [
    ...sources.aliases.map(
      (alias): ReferenceEntry => ({
        kind: 'alias',
        token: `alias:${alias.name}`,
        name: alias.name,
        detail: alias.target,
      })
    ),
    ...sources.skills.map(
      (skill): ReferenceEntry => ({
        kind: 'skill',
        token: `skill:${skill.name}`,
        name: skill.name,
        detail: skill.description,
      })
    ),
    ...sources.agents.map(
      (agent): ReferenceEntry => ({
        kind: 'agent',
        token: `agent:${agent.name}`,
        name: agent.name,
        detail: agent.description,
      })
    ),
    ...sources.files.map(
      (file): ReferenceEntry => ({
        kind: file.kind,
        token: file.path,
        name: file.name,
        detail: file.path,
        extension: file.extension,
      })
    ),
  ]
  return (
    candidates
      .filter((entry) => !only || entry.kind === only)
      // A typed token must stay a typed token: a name the pattern cannot carry
      // would insert a reference that reads back as something else.
      .filter((entry) =>
        entry.kind === 'file' || entry.kind === 'directory'
          ? true
          : typedReference(entry.token) !== null
      )
      .map((entry) => ({ entry, s: score(q, entry.name, entry.detail) }))
      .filter(({ s }) => s > 0)
      .sort(
        (a, b) =>
          b.s - a.s ||
          KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind] ||
          a.entry.name.length - b.entry.name.length ||
          a.entry.token.localeCompare(b.entry.token)
      )
      .slice(0, limit)
      .map(({ entry }) => entry)
  )
}
