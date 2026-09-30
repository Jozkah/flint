/**
 * A one-line account of a finished run, for the folded steps toggle:
 * "Ran 20 commands, created 8 files, used 6 tools +645 −0".
 *
 * "N steps" says how much happened but not what; the counts say what kind of
 * work it was, and the line totals say how much of it changed files.
 */
import { toolKind } from '@/lib/toolKind'

export type TraceSummaryPart = {
  type: string
  state?: string
  input?: unknown
}

export type TraceSummary = {
  commands: number
  created: number
  edited: number
  read: number
  searched: number
  /** Every other call: web, MCP, memory, skills. */
  tools: number
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

/** Count a run's tool parts by what they did. Failed calls do not count. */
export function summarizeTrace(parts: TraceSummaryPart[]): TraceSummary {
  const out: TraceSummary = {
    commands: 0,
    created: 0,
    edited: 0,
    read: 0,
    searched: 0,
    tools: 0,
    added: 0,
    removed: 0,
  }
  const created = new Set<string>()
  const edited = new Set<string>()
  const read = new Set<string>()
  let anonymous = 0
  for (const part of parts) {
    if (!part.type.startsWith('tool-')) continue
    if (part.state === 'output-error' || part.state === 'output-denied') continue
    const name = part.type.slice('tool-'.length)
    const input = (part.input ?? {}) as Record<string, unknown>
    const path = str(input.path) ?? str(input.file_path)
    if (name === 'write') {
      created.add(path ?? `#${anonymous++}`)
      out.added += lines(input.content)
    } else if (name === 'edit') {
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

/** The summary's phrases in reading order, each a translation key and count. */
export function summaryPhrases(
  s: TraceSummary
): { key: 'commands' | 'created' | 'edited' | 'read' | 'searched' | 'tools'; count: number }[] {
  const order = ['commands', 'created', 'edited', 'read', 'searched', 'tools'] as const
  return order.filter((key) => s[key] > 0).map((key) => ({ key, count: s[key] }))
}
