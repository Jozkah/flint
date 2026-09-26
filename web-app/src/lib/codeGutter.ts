/**
 * Change markers and inline blame for the Code panel.
 *
 * Pure: the hunks between a base (HEAD, or the original of a sandbox copy)
 * and the text in the editor, reverting one hunk, and parsing
 * `git blame --porcelain`. Recomputed on every keystroke, so the diff trims
 * the common head and tail first and only runs a line LCS over what is left.
 */

export type ChangeHunk = {
  kind: 'added' | 'modified' | 'deleted'
  /** 1-based first line in the new text. For `deleted`, the line the
   * deletion sits above (the marker's line); may be `lines + 1` at EOF. */
  start: number
  /** 1-based last line in the new text; `start - 1` for `deleted`. */
  end: number
  /** The base lines this hunk replaced (empty for `added`). */
  oldLines: string[]
  /** The new lines (empty for `deleted`). */
  newLines: string[]
}

const splitLines = (text: string): string[] => {
  if (text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Above this many cells the middle is one modified block rather than LCS'd. */
const MAX_LCS_CELLS = 4_000_000

export function computeHunks(base: string, text: string): ChangeHunk[] {
  const a = splitLines(base)
  const b = splitLines(text)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  if (midA.length === 0 && midB.length === 0) return []

  // Pairs of matching indices (in the middle slices), in order.
  let matches: [number, number][] = []
  if (
    midA.length > 0 &&
    midB.length > 0 &&
    midA.length * midB.length <= MAX_LCS_CELLS
  ) {
    const n = midA.length
    const m = midB.length
    const dp = new Uint32Array((n + 1) * (m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        matches.push([i, j])
        i++
        j++
      } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
        i++
      } else {
        j++
      }
    }
  } else {
    matches = []
  }

  const hunks: ChangeHunk[] = []
  let pa = 0
  let pb = 0
  const flush = (toA: number, toB: number) => {
    const oldLines = midA.slice(pa, toA)
    const newLines = midB.slice(pb, toB)
    if (oldLines.length === 0 && newLines.length === 0) return
    const start = head + pb + 1
    hunks.push({
      kind:
        oldLines.length === 0
          ? 'added'
          : newLines.length === 0
            ? 'deleted'
            : 'modified',
      start,
      end: start + newLines.length - 1,
      oldLines,
      newLines,
    })
  }
  for (const [ia, ib] of matches) {
    flush(ia, ib)
    pa = ia + 1
    pb = ib + 1
  }
  flush(midA.length, midB.length)
  return hunks
}

/** `text` with one hunk put back as the base had it. */
export function revertHunk(text: string, hunk: ChangeHunk): string {
  const crlf = text.includes('\r\n')
  const endsWithNewline = /\n$/.test(text)
  const lines = splitLines(text)
  lines.splice(hunk.start - 1, hunk.newLines.length, ...hunk.oldLines)
  const joined = lines.join(crlf ? '\r\n' : '\n')
  return joined && (endsWithNewline || lines.length === 0)
    ? joined + (crlf ? '\r\n' : '\n')
    : joined
}

/** Line number to marker kind, for painting a gutter. */
export function markersByLine(
  hunks: readonly ChangeHunk[]
): Map<number, ChangeHunk> {
  const out = new Map<number, ChangeHunk>()
  for (const hunk of hunks) {
    if (hunk.kind === 'deleted') {
      out.set(Math.max(1, hunk.start - 1), hunk)
      continue
    }
    for (let line = hunk.start; line <= hunk.end; line++) out.set(line, hunk)
  }
  return out
}

// ---------------------------------------------------------------------------
// Blame
// ---------------------------------------------------------------------------

export type BlameCommit = {
  sha: string
  author: string
  /** Seconds since the epoch. */
  time: number
  summary: string
  /** The zero sha: the line is not committed. */
  uncommitted: boolean
}

export type Blame = {
  /** Indexed by 1-based final line. */
  lines: (BlameCommit | undefined)[]
}

const ZERO_SHA = /^0{40}$/

export function parseBlamePorcelain(raw: string): Blame {
  const commits = new Map<string, BlameCommit>()
  const lines: (BlameCommit | undefined)[] = []
  let current: BlameCommit | null = null
  let currentLine = 0
  for (const line of raw.split('\n')) {
    if (line.startsWith('\t')) {
      if (current) lines[currentLine] = current
      current = null
      continue
    }
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line)
    if (header) {
      const sha = header[1]
      currentLine = Number(header[2])
      current = commits.get(sha) ?? {
        sha,
        author: '',
        time: 0,
        summary: '',
        uncommitted: ZERO_SHA.test(sha),
      }
      commits.set(sha, current)
      continue
    }
    if (!current) continue
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    if (key === 'author') current.author = value
    else if (key === 'author-time') current.time = Number(value) || 0
    else if (key === 'summary') current.summary = value
  }
  return { lines }
}

/**
 * Blame for the text in the editor, from blame of the text on disk: lines the
 * editor changed are not committed, the rest shift with the edits above them.
 */
export function blameForEdited(
  blame: Blame,
  disk: string,
  text: string
): (BlameCommit | undefined)[] {
  if (disk === text) return blame.lines
  const uncommitted: BlameCommit = {
    sha: '0'.repeat(40),
    author: '',
    time: 0,
    summary: '',
    uncommitted: true,
  }
  const out: (BlameCommit | undefined)[] = []
  const total = splitLines(text).length
  let oldLine = 1
  let newLine = 1
  for (const hunk of computeHunks(disk, text)) {
    // Unchanged run before this hunk.
    while (newLine < hunk.start && newLine <= total) {
      out[newLine++] = blame.lines[oldLine++]
    }
    for (let i = 0; i < hunk.newLines.length; i++) out[newLine++] = uncommitted
    oldLine += hunk.oldLines.length
  }
  while (newLine <= total) out[newLine++] = blame.lines[oldLine++]
  return out
}

/** "2 weeks ago", from seconds; coarse on purpose, like GitLens. */
export function relativeTime(
  seconds: number,
  now: number = Date.now() / 1000
): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const diff = Math.max(0, now - seconds)
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ]
  for (const [size, unit] of steps) {
    if (diff >= size) return { value: -Math.floor(diff / size), unit }
  }
  return { value: 0, unit: 'second' }
}
