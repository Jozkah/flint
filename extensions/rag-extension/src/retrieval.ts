/**
 * Turning the `file_ids` a model passes to `retrieve` into ids the vector
 * store knows. Models often name a file the way the user did ("report.pdf")
 * instead of by the opaque id `list_attachments` returned, and a filter that
 * matches nothing makes the search return nothing, which reads as "the
 * document does not say".
 */

export type FileRef = {
  id: string
  name?: string
  path?: string
}

export type FileFilter = {
  /** Resolved ids to search within; `undefined` means search every file. */
  fileIds: string[] | undefined
  /** Requested entries that matched no attached file. */
  unmatched: string[]
}

/** Last path segment, either separator. */
function basename(value: string): string {
  const parts = value.split(/[\\/]/)
  return parts[parts.length - 1] ?? value
}

/**
 * Match each requested entry against the attached files: by id first, then by
 * name or basename, case-insensitively. When nothing matches the filter is
 * dropped (a search over everything beats a search over nothing) and the
 * entries are reported as `unmatched` so the answer can say so.
 */
export function resolveFileFilter(
  requested: string[] | undefined,
  files: FileRef[]
): FileFilter {
  const wanted = (requested ?? []).map((r) => r.trim()).filter(Boolean)
  if (wanted.length === 0) return { fileIds: undefined, unmatched: [] }

  const matched = new Set<string>()
  const unmatched: string[] = []
  for (const ref of wanted) {
    const byId = files.find((f) => f.id === ref)
    if (byId) {
      matched.add(byId.id)
      continue
    }
    const lower = ref.toLowerCase()
    const lowerBase = basename(ref).toLowerCase()
    const byName = files.filter((f) => {
      const names = [f.name, f.path ? basename(f.path) : undefined]
        .filter((n): n is string => !!n)
        .flatMap((n) => [n.toLowerCase(), basename(n).toLowerCase()])
      return names.includes(lower) || names.includes(lowerBase)
    })
    if (byName.length === 0) {
      unmatched.push(ref)
      continue
    }
    for (const f of byName) matched.add(f.id)
  }
  return {
    fileIds: matched.size > 0 ? [...matched] : undefined,
    unmatched,
  }
}

/** The sentence added to a retrieve answer when some entries matched nothing. */
export function unmatchedNote(filter: FileFilter): string | undefined {
  if (filter.unmatched.length === 0) return undefined
  const names = filter.unmatched.map((u) => `"${u}"`).join(', ')
  return filter.fileIds
    ? `No attached file matched ${names}; searched the others you named.`
    : `No attached file matched ${names}; searched all attached files instead. Use list_attachments for exact ids.`
}
