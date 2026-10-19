/**
 * A one-line account of a finished run, for the folded steps toggle:
 * "Edited 2 files, ran 20 commands (1 failed), used 6 tools +645 −0".
 *
 * "N steps" says how much happened but not what; the counts say what kind of
 * work it was, and the line totals say how much of it changed files.
 */
import { toolKind } from '@/lib/toolKind'
import { parseBashOutput } from '@/lib/toolPresentation'

export type TraceSummaryPart = {
  type: string
  state?: string
  input?: unknown
  output?: unknown
}

export type SummaryKey = 'edited' | 'created' | 'commands' | 'read' | 'searched' | 'tools'

export type TraceSummary = {
  commands: number
  created: number
  edited: number
  read: number
  searched: number
  /** Every other call: web, MCP, memory, skills. */
  tools: number
  /** Calls that failed, however they failed; also counted in their kind. */
  failed: number
  /** The failures by kind, so each one is reported next to what failed. */
  failedBy: Record<SummaryKey, number>
  added: number
  removed: number
}

const lines = (text: unknown): number => {
  if (typeof text !== 'string' || text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

const splitLines = (text: unknown): string[] =>
  typeof text === 'string' && text !== ''
    ? text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
    : []

/**
 * Lines an edit really adds and removes: the lines the old and new text share
 * are neither (a replacement that only grows a block is +3 -0, not +5 -2).
 */
export function editLineCounts(
  oldText: unknown,
  newText: unknown
): { added: number; removed: number } {
  let a = splitLines(oldText)
  let b = splitLines(newText)
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++
  let hi = 0
  while (
    hi < a.length - lo &&
    hi < b.length - lo &&
    a[a.length - 1 - hi] === b[b.length - 1 - hi]
  ) {
    hi++
  }
  a = a.slice(lo, a.length - hi)
  b = b.slice(lo, b.length - hi)
  // Longest common subsequence of what is left, unless it is too big to be
  // worth it: then the trimmed counts stand.
  let common = 0
  if (a.length > 0 && b.length > 0 && a.length * b.length <= 250_000) {
    let prev = new Array<number>(b.length + 1).fill(0)
    for (let i = 1; i <= a.length; i++) {
      const row = new Array<number>(b.length + 1).fill(0)
      for (let j = 1; j <= b.length; j++) {
        row[j] =
          a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1])
      }
      prev = row
    }
    common = prev[b.length]
  }
  return { added: b.length - common, removed: a.length - common }
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined

const REFUSED_WRITE =
  /^\s*(ERROR\b|Denied\b|The user denied|User denied|Refused\b)|\[sandbox_denied\]|permission_denied|denied by (this machine|project|policy)|tool_rule|\bwas (refused|denied)\b|plan mode/i

function refusedWriteOutput(part: TraceSummaryPart & { approval?: { approved?: unknown } }): boolean {
  if (part.approval?.approved === false) return true
  const out = part.output
  if (typeof out === 'string') return REFUSED_WRITE.test(out)
  return Boolean(
    out && typeof out === 'object' && (out as { isError?: unknown }).isError === true
  )
}

/**
 * A call that did not do what it was asked: refused, errored, or a command
 * that exited non-zero.
 */
export function partFailed(part: TraceSummaryPart): boolean {
  if (part.state === 'output-error' || part.state === 'output-denied') return true
  // A refusal that came back as the call's output (a server's Cowork run, an
  // older record) did not write anything either: the user said no, or a rule
  // refused, so it must not be counted as a file created or changed.
  if (
    part.state === 'output-available' &&
    (part.type === 'tool-write' || part.type === 'tool-edit') &&
    refusedWriteOutput(part)
  ) {
    return true
  }
  if (part.type !== 'tool-bash' || part.state !== 'output-available') return false
  const out = parseBashOutput(part.output)
  return (out.exit ?? 0) !== 0 || out.signaled
}

/**
 * A call that has finished, well or badly. One still streaming, running or
 * awaiting approval has done nothing yet, so the summary leaves it out.
 * Parts without a state (room calls, older records) are finished.
 */
export function partDone(part: TraceSummaryPart): boolean {
  return (
    part.state === undefined ||
    part.state === 'output-available' ||
    part.state === 'output-error' ||
    part.state === 'output-denied'
  )
}

/** The kind a tool call is counted under. */
function partKey(name: string): SummaryKey {
  if (name === 'write') return 'created'
  if (name === 'edit') return 'edited'
  if (name === 'read') return 'read'
  const kind = toolKind({ name })
  if (name === 'bash' || kind === 'bash') return 'commands'
  if (kind === 'search' && !name.startsWith('web_')) return 'searched'
  return 'tools'
}

// The summary is rebuilt on every streamed update; an edit's line diff does
// not change once the edit exists, so it is worked out once per edit object.
const editCounts = new WeakMap<object, { added: number; removed: number }>()

function countsOf(edit: Record<string, unknown> | undefined) {
  if (!edit || typeof edit !== 'object') return editLineCounts(undefined, undefined)
  let hit = editCounts.get(edit)
  if (!hit) {
    hit = editLineCounts(edit.old_string, edit.new_string)
    editCounts.set(edit, hit)
  }
  return hit
}

/**
 * Count a run's finished tool parts by what they did.
 *
 * Files count once per path, and a path counts as failed only when its last
 * attempt failed, so a retried edit that went through is not a failure. A
 * command run again straight after it failed, with no other call between, is
 * the same command retried; one re-run after other work counts again.
 */
export function summarizeTrace(parts: TraceSummaryPart[]): TraceSummary {
  const out: TraceSummary = {
    commands: 0,
    created: 0,
    edited: 0,
    read: 0,
    searched: 0,
    tools: 0,
    failed: 0,
    failedBy: { edited: 0, created: 0, commands: 0, read: 0, searched: 0, tools: 0 },
    added: 0,
    removed: 0,
  }
  // Per path, whether its latest attempt failed.
  const files: Record<'created' | 'edited' | 'read', Map<string, boolean>> = {
    created: new Map(),
    edited: new Map(),
    read: new Map(),
  }
  type Call = { key: SummaryKey; command?: string; failed: boolean }
  const calls: Call[] = []
  // The call just before this one, for spotting a straight retry.
  let prev: Call | undefined
  let anonymous = 0
  for (const part of parts) {
    if (!part.type.startsWith('tool-') || !partDone(part)) continue
    const failed = partFailed(part)
    const name = part.type.slice('tool-'.length)
    const key = partKey(name)
    const input = (part.input ?? {}) as Record<string, unknown>
    const previous = prev
    prev = undefined
    if (key === 'created' || key === 'edited' || key === 'read') {
      const path = str(input.path) ?? str(input.file_path) ?? `#${anonymous++}`
      files[key].set(path, failed)
      if (failed) continue
      if (key === 'created') out.added += lines(input.content)
      if (key === 'edited') {
        const edits = Array.isArray(input.edits) ? input.edits : []
        for (const e of edits as Record<string, unknown>[]) {
          const { added, removed } = countsOf(e)
          out.added += added
          out.removed += removed
        }
      }
      continue
    }
    const command = key === 'commands' ? str(input.command) : undefined
    if (command && previous?.failed && previous.command === command) {
      previous.failed = failed
      prev = previous
      continue
    }
    prev = { key, command, failed }
    calls.push(prev)
  }
  for (const key of ['created', 'edited', 'read'] as const) {
    out[key] = files[key].size
    for (const failed of files[key].values()) if (failed) out.failedBy[key]++
  }
  for (const c of calls) {
    out[c.key]++
    if (c.failed) out.failedBy[c.key]++
  }
  out.failed = Object.values(out.failedBy).reduce((a, b) => a + b, 0)
  return out
}

/**
 * The summary as one plain line, each failure next to the kind that failed:
 * "Edited 1 file, ran 3 commands (1 failed) +12 −3".
 * Undefined when nothing ran, so the caller keeps its own wording.
 */
export function summaryLabel(
  s: TraceSummary,
  t: (key: string, options?: Record<string, unknown>) => string
): string | undefined {
  const text = summaryPhrases(s)
    .map((p) => {
      const phrase = t(
        `chat:transcriptView.summary.${p.none ? `${p.key}None` : p.key}`,
        { count: p.count }
      )
      return p.failed > 0
        ? `${phrase} (${t('chat:transcriptView.summary.failed', { count: p.failed })})`
        : phrase
    })
    .join(', ')
  if (!text) return undefined
  const diff = s.added > 0 || s.removed > 0 ? ` +${s.added} −${s.removed}` : ''
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${diff}`
}

/** The same line in two parts, so the line counts can be coloured. */
export function summaryLabelParts(
  s: TraceSummary,
  t: (key: string, options?: Record<string, unknown>) => string
): { text: string; added: number; removed: number } | undefined {
  const full = summaryLabel({ ...s, added: 0, removed: 0 }, t)
  return full ? { text: full, added: s.added, removed: s.removed } : undefined
}

/**
 * The summary's phrases in a fixed order: changes to files first (edited,
 * created), then commands, then what was only looked at (read, searched),
 * then everything else. Each carries its own failure count.
 */
export const SUMMARY_ORDER = [
  'edited',
  'created',
  'commands',
  'read',
  'searched',
  'tools',
] as const satisfies readonly SummaryKey[]

export function summaryPhrases(
  s: TraceSummary
): { key: SummaryKey; count: number; failed: number; none?: boolean }[] {
  return SUMMARY_ORDER.filter((key) => s[key] > 0).map((key) => {
    const failed = s.failedBy?.[key] ?? 0
    // A write or edit that failed did not create or change anything, so it is
    // not counted as done: "created 2 files (2 failed)" read as if it had.
    if (key === 'created' || key === 'edited') {
      const done = s[key] - failed
      if (done <= 0) return { key, count: failed, failed: 0, none: true }
      return { key, count: done, failed }
    }
    return { key, count: s[key], failed }
  })
}

/**
 * Every finished call on its own line with how it went, for the summary's
 * tooltip: "✓ Ran git status" / "✗ Edited y.ts".
 */
export function summaryDetails(parts: TraceSummaryPart[]): string {
  return parts
    .filter((p) => p.type.startsWith('tool-') && partDone(p))
    .map((p) => `${partFailed(p) ? '✗' : '✓'} ${toolSentence(p)}`)
    .join('\n')
}

const basename = (p: string): string =>
  p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

const clip = (text: string, max = 80): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * One past-tense line for a tool call in a folded run: "Read AUDIT.md",
 * "Ran git status". A model-written `description` on the call wins, since it
 * knows why the call was made; otherwise it is built from the arguments.
 */
export function toolSentence(part: TraceSummaryPart): string {
  const name = part.type.replace(/^tool-/, '')
  const input = (part.input ?? {}) as Record<string, unknown>
  const described = str(input.description)
  if (described) return clip(described, 100)
  const path = str(input.path) ?? str(input.file_path)
  const pattern = str(input.pattern)
  switch (name) {
    case 'read':
      return path ? `Read ${basename(path)}` : 'Read a file'
    case 'write':
      return path ? `Created ${basename(path)}` : 'Created a file'
    case 'edit':
      return path ? `Edited ${basename(path)}` : 'Edited a file'
    case 'ls':
      return path ? `Listed ${basename(path)}` : 'Listed the folder'
    case 'find':
      return pattern ? `Found files matching ${clip(pattern, 40)}` : 'Found files'
    case 'grep':
      return pattern ? `Searched for ${clip(pattern, 40)}` : 'Searched files'
    case 'bash': {
      const command = str(input.command)
      return command ? `Ran ${clip(command)}` : 'Ran a command'
    }
    case 'web_search': {
      const query = str(input.query)
      return query ? `Searched the web for ${clip(query, 50)}` : 'Searched the web'
    }
    case 'web_fetch': {
      const url = str(input.url)
      return url ? `Fetched ${clip(url, 60)}` : 'Fetched a page'
    }
    case 'skill_read': {
      const skill = str(input.name)
      return skill ? `Used ${skill}` : 'Used a skill'
    }
    default: {
      const spaced = name.replace(/[_-]+/g, ' ').trim()
      return spaced ? `Used ${spaced}` : 'Used a tool'
    }
  }
}
