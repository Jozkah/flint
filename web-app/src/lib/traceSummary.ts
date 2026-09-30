/**
 * A one-line account of a finished run, for the folded steps toggle:
 * "Ran 20 commands, created 8 files, used 6 tools +645 −0".
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
  added: number
  removed: number
}

const lines = (text: unknown): number => {
  if (typeof text !== 'string' || text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined

/**
 * A call that did not do what it was asked: refused, errored, or a command
 * that exited non-zero.
 */
export function partFailed(part: TraceSummaryPart): boolean {
  if (part.state === 'output-error' || part.state === 'output-denied') return true
  if (part.type !== 'tool-bash' || part.state !== 'output-available') return false
  const out = parseBashOutput(part.output)
  return (out.exit ?? 0) !== 0 || out.signaled
}

/** Count a run's tool parts by what they did. */
export function summarizeTrace(parts: TraceSummaryPart[]): TraceSummary {
  const out: TraceSummary = {
    commands: 0,
    created: 0,
    edited: 0,
    read: 0,
    searched: 0,
    tools: 0,
    failed: 0,
    added: 0,
    removed: 0,
  }
  const created = new Set<string>()
  const edited = new Set<string>()
  const read = new Set<string>()
  let anonymous = 0
  for (const part of parts) {
    if (!part.type.startsWith('tool-')) continue
    const failed = partFailed(part)
    if (failed) out.failed++
    const name = part.type.slice('tool-'.length)
    const input = (part.input ?? {}) as Record<string, unknown>
    const path = str(input.path) ?? str(input.file_path)
    if (name === 'write') {
      if (failed) continue
      created.add(path ?? `#${anonymous++}`)
      out.added += lines(input.content)
    } else if (name === 'edit') {
      if (failed) continue
      edited.add(path ?? `#${anonymous++}`)
      const edits = Array.isArray(input.edits) ? input.edits : []
      for (const e of edits as Record<string, unknown>[]) {
        out.added += lines(e?.new_string)
        out.removed += lines(e?.old_string)
      }
    } else if (name === 'read') {
      read.add(path ?? `#${anonymous++}`)
    } else {
      const kind = toolKind({ name })
      if (name === 'bash' || kind === 'bash') out.commands++
      else if (kind === 'search' && !name.startsWith('web_')) out.searched++
      else out.tools++
    }
  }
  out.created = created.size
  out.edited = edited.size
  out.read = read.size
  return out
}

/**
 * The summary as one plain line: "Ran 3 commands, created 1 file (1 failed) +12 −3".
 * Undefined when nothing ran, so the caller keeps its own wording.
 */
export function summaryLabel(
  s: TraceSummary,
  t: (key: string, options?: Record<string, unknown>) => string
): string | undefined {
  const text = summaryPhrases(s)
    .map((p) => t(`chat:transcriptView.summary.${p.key}`, { count: p.count }))
    .join(', ')
  if (!text) return undefined
  const failed =
    s.failed > 0
      ? ` (${t('chat:transcriptView.summary.failed', { count: s.failed })})`
      : ''
  const diff = s.added > 0 || s.removed > 0 ? ` +${s.added} −${s.removed}` : ''
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${failed}${diff}`
}

/** The summary's phrases in reading order, each a translation key and count. */
export function summaryPhrases(
  s: TraceSummary
): { key: 'commands' | 'created' | 'edited' | 'read' | 'searched' | 'tools'; count: number }[] {
  const order = ['commands', 'created', 'edited', 'read', 'searched', 'tools'] as const
  return order.filter((key) => s[key] > 0).map((key) => ({ key, count: s[key] }))
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
