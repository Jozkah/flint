/**
 * Parsing a unified diff into something a gutter can be drawn beside.
 *
 * The diffs come from git and from the agent's own `write`/`edit` tools, so
 * this only ever reads them — it never reconstructs a diff, and nothing it
 * produces is sent back to a model. Display-only, by design.
 *
 * Unparseable input is not an error: a diff that does not match the grammar is
 * still text the user may need to read, so it comes back as a single hunkless
 * block rather than being dropped.
 */

export type DiffLineKind = 'context' | 'add' | 'remove' | 'meta'

export type DiffLine = {
  kind: DiffLineKind
  /** Text without the leading marker. */
  content: string
  /** Line number in the original file, where one applies. */
  oldNumber?: number
  /** Line number in the new file, where one applies. */
  newNumber?: number
}

export type DiffHunk = {
  /** The `@@ ... @@` line, kept verbatim as the section's heading. */
  header: string
  /** Anything git prints after the closing `@@`, usually the enclosing scope. */
  heading?: string
  lines: DiffLine[]
}

export type ParsedDiff = {
  hunks: DiffHunk[]
  additions: number
  deletions: number
  /** The diff carried no hunk headers, so it is shown as plain text. */
  unstructured: boolean
}

const HUNK = /^@@+\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@+(.*)$/

/** Lines git emits around a diff that are not part of the body. */
const FILE_HEADER =
  /^(diff --git |index |--- |\+\+\+ |similarity index |rename (from|to) |new file mode |deleted file mode |old mode |new mode )/

const kindOfLooseLine = (line: string): DiffLineKind =>
  line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context'

export function parseUnifiedDiff(raw: string): ParsedDiff {
  const lines = raw.split('\n')
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  let additions = 0
  let deletions = 0

  for (const line of lines) {
    const match = HUNK.exec(line)
    if (match) {
      current = {
        header: line.slice(0, line.lastIndexOf('@@') + 2),
        heading: match[5]?.trim() || undefined,
        lines: [],
      }
      hunks.push(current)
      oldLine = Number(match[1])
      newLine = Number(match[3])
      continue
    }

    // Before the first hunk: file headers, which belong to no hunk.
    if (!current) continue

    if (line.startsWith('+')) {
      additions++
      current.lines.push({
        kind: 'add',
        content: line.slice(1),
        newNumber: newLine++,
      })
    } else if (line.startsWith('-')) {
      deletions++
      current.lines.push({
        kind: 'remove',
        content: line.slice(1),
        oldNumber: oldLine++,
      })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — a note about the line above, which
      // consumes no number on either side.
      current.lines.push({ kind: 'meta', content: line.slice(1).trim() })
    } else if (FILE_HEADER.test(line)) {
      continue
    } else {
      current.lines.push({
        kind: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
        oldNumber: oldLine++,
        newNumber: newLine++,
      })
    }
  }

  if (hunks.length === 0) {
    // No recognisable hunks. Rather than show nothing, show the text.
    const body = lines.filter((l) => l.length > 0)
    return {
      hunks: body.length
        ? [
            {
              header: '',
              lines: body.map((content) => ({
                kind: kindOfLooseLine(content),
                content: content.replace(/^[+-]/, ''),
              })),
            },
          ]
        : [],
      additions: body.filter((l) => l.startsWith('+')).length,
      deletions: body.filter((l) => l.startsWith('-')).length,
      unstructured: true,
    }
  }

  return { hunks, additions, deletions, unstructured: false }
}

/**
 * How wide the gutter must be to hold every number without reflowing.
 *
 * Measured rather than guessed, so a four-digit file does not shift the
 * columns halfway down the diff.
 */
export function gutterWidth(parsed: ParsedDiff): number {
  let widest = 1
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      widest = Math.max(
        widest,
        String(line.oldNumber ?? '').length,
        String(line.newNumber ?? '').length
      )
    }
  }
  return widest
}

/** Total rendered lines, for deciding whether to truncate. */
export const diffLineCount = (parsed: ParsedDiff): number =>
  parsed.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)

/**
 * Diffs longer than this are cut off with a note.
 *
 * A review surface that locks the window while it lays out ten thousand rows
 * is not a review surface.
 */
export const MAX_RENDERED_DIFF_LINES = 1500

export function truncateDiff(
  parsed: ParsedDiff,
  max = MAX_RENDERED_DIFF_LINES
): { parsed: ParsedDiff; omitted: number } {
  const total = diffLineCount(parsed)
  if (total <= max) return { parsed, omitted: 0 }

  const hunks: DiffHunk[] = []
  let remaining = max
  for (const hunk of parsed.hunks) {
    if (remaining <= 0) break
    hunks.push({ ...hunk, lines: hunk.lines.slice(0, remaining) })
    remaining -= hunk.lines.length
  }
  return { parsed: { ...parsed, hunks }, omitted: total - max }
}
