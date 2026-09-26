import type { ToolUIPart } from 'ai'
import type { ToolOrigin } from './toolOrigin'

/** The call is still being written or executed: no result yet. */
export const isToolRunning = (state: ToolUIPart['state']) =>
  state === 'input-streaming' || state === 'input-available'

/**
 * The chrome a native tool call is presented as: web search reads as a search
 * bar the model types into, web fetch as an address bar.
 */
export type ToolCallBar =
  | { variant: 'search'; query: string; count?: number }
  | { variant: 'address'; url: string }
  | { variant: 'documents'; query: string; count?: number; fileCount?: number }
  /** `bash`, presented as a terminal. `jobId` set = polling a backgrounded run. */
  | { variant: 'terminal'; command: string; jobId?: string }
  /**
   * The workspace tools. `target` is whatever the call is really about -- a path
   * for read/ls, the pattern for find/grep, the entry name for memory/skill --
   * with `detail` carrying the secondary argument when there is one.
   */
  | {
      variant: 'workspace'
      tool: string
      target: string
      detail?: string
      /** grep only: how the pattern was matched, for highlighting results. */
      grep?: { literal: boolean; ignoreCase: boolean }
    }

/**
 * Owned by the RAG extension (extensions/rag-extension/src/tools.ts) and not
 * exported through @janhq/core, so this must stay in sync with it. Only
 * `retrieve` gets a bar; the other RAG tools fall back to the generic card.
 */
export const RAG_RETRIEVE_TOOL = 'retrieve'

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : ''

/**
 * Build the bar for a native tool call from its arguments. Arguments stream in,
 * so a missing or partial value is normal and renders as an empty/partial bar
 * rather than being suppressed.
 */
export function describeNativeToolCall(
  origin: ToolOrigin | undefined,
  toolName: string,
  input: unknown
): ToolCallBar | undefined {
  if (!origin) return undefined
  const args = (input ?? {}) as Record<string, unknown>
  const asCount = (value: unknown) =>
    typeof value === 'number' ? value : undefined

  if (origin.kind === 'web-search') {
    return { variant: 'search', query: asString(args.query), count: asCount(args.count) }
  }
  if (origin.kind === 'web-fetch') {
    return { variant: 'address', url: asString(args.url) }
  }
  if (origin.kind === 'rag' && toolName === RAG_RETRIEVE_TOOL) {
    return {
      variant: 'documents',
      query: asString(args.query),
      count: asCount(args.top_k),
      fileCount: Array.isArray(args.file_ids) ? args.file_ids.length : undefined,
    }
  }
  if (origin.kind === 'agent') {
    if (toolName === 'bash') {
      const jobId = asString(args.job_id)
      return {
        variant: 'terminal',
        command: asString(args.command),
        jobId: jobId || undefined,
      }
    }
    // find/grep are about their pattern, with the directory as context; the
    // others are about the single path or name they act on. `ls` defaults to the
    // workspace root, which the widget shows rather than an empty bar.
    if (toolName === 'find' || toolName === 'grep') {
      return {
        variant: 'workspace',
        tool: toolName,
        target: asString(args.pattern),
        detail: asString(args.path) || undefined,
        ...(toolName === 'grep'
          ? {
              grep: {
                literal: args.literal === true,
                ignoreCase: args.ignore_case === true,
              },
            }
          : {}),
      }
    }
    return {
      variant: 'workspace',
      tool: toolName,
      target: asString(args.path) || asString(args.name),
    }
  }
  return undefined
}

export type BashOutput = {
  /** Combined stdout/stderr with the status and notice lines removed. */
  text: string
  exit?: number
  /** The run was killed by a signal instead of exiting. */
  signaled: boolean
  /** Output exceeded the cap; only the last lines are present. */
  truncated: boolean
  /** The OS sandbox refused something; explains the limits that applied. */
  sandboxNote?: string
  /**
   * This is the result of a rerun outside the sandbox the user allowed after
   * Windows' null device refused the sandboxed run. The note saying so is
   * for the model and is removed from `text`.
   */
  ranUnsandboxed: boolean
}

/** Global: the exit marker is not always last, so every match is considered. */
const EXIT_LINE = /\n?\[exit (-?\d+)\]/g
const SIGNAL_LINE = /\n?\[terminated by signal\]/
const TRUNCATION_NOTICE = /\n?\[output truncated[^\]]*\]/
const SANDBOX_NOTICE = /\n?\[sandbox: ([^\]]*)\]/
/** `RAN_UNSANDBOXED_NOTE` (lib/nullDeviceRetry.ts), leading a rerun's output. */
const RAN_UNSANDBOXED_NOTICE =
  /^\[The sandboxed run failed because Windows' null device refuses sandboxed programs\.[^\]]*\]\n/

/**
 * Split `bash`'s `[exit N]` / `[terminated by signal]` status and its trailing
 * notices off its output (see the tool description in `schema.rs`), so the
 * terminal can show a status of its own instead of leaving markers in the
 * scrollback. Absent or partial markers are normal: the run may still be going.
 *
 * The exit marker is deliberately not anchored to the end of the string. Rust
 * appends the truncation notice and the sandbox hint *after* it, so anchoring
 * would silently lose the exit code exactly when something went wrong.
 */
export function parseBashOutput(output: unknown): BashOutput {
  const raw =
    typeof output === 'string'
      ? output
      : typeof (output as { content?: unknown })?.content === 'string'
        ? (output as { content: string }).content
        : ''

  const ranUnsandboxed = RAN_UNSANDBOXED_NOTICE.test(raw)
  const text = raw.replace(RAN_UNSANDBOXED_NOTICE, '')
  const truncated = TRUNCATION_NOTICE.test(text)
  const signaled = SIGNAL_LINE.test(text)
  const sandboxNote = text.match(SANDBOX_NOTICE)?.[1]
  // The last marker is the real one: a command can echo `[exit 0]` itself.
  const exits = [...text.matchAll(EXIT_LINE)]
  const exitMatch = exits.at(-1)

  let body = exitMatch ? text.slice(0, exitMatch.index) : text
  body = body
    .replace(SIGNAL_LINE, '')
    .replace(TRUNCATION_NOTICE, '')
    .replace(SANDBOX_NOTICE, '')

  return {
    text: body.replace(/\s+$/, ''),
    exit: exitMatch ? Number(exitMatch[1]) : undefined,
    signaled,
    truncated,
    sandboxNote,
    ranUnsandboxed,
  }
}

export type WebFetchPage = {
  title?: string
  url?: string
  content: string
  truncated: boolean
}

const TRUNCATION_MARKER = '\n\n[content truncated]'
const FETCH_HEADER = /^Title: (.*)\nURL: (.*)\n\n([\s\S]*)$/

/**
 * web_fetch returns a plain-text blob prefixed with `Title:` / `URL:` lines
 * (see executeWebTool), not a structured payload. Split it back apart so the
 * page can be presented as a page instead of a wall of text.
 */
export function parseWebFetchOutput(output: unknown): WebFetchPage | undefined {
  const text =
    typeof output === 'string'
      ? output
      : typeof (output as { content?: unknown })?.content === 'string'
        ? ((output as { content: string }).content)
        : undefined
  if (text === undefined) return undefined

  const truncated = text.endsWith(TRUNCATION_MARKER)
  const body = truncated ? text.slice(0, -TRUNCATION_MARKER.length) : text

  const match = body.match(FETCH_HEADER)
  if (!match) return { content: body, truncated }

  return {
    title: match[1] || undefined,
    url: match[2] || undefined,
    content: match[3],
    truncated,
  }
}

export type GrepLine = { line: number; match: boolean; text: string }
export type GrepGroup = { file: string; lines: GrepLine[]; gaps: number[] }
export type GrepOutput = {
  groups: GrepGroup[]
  /** Trailing notices (result cap, byte truncation), shown as-is. */
  notes: string[]
}

const GREP_LINE = /^ {2}(\d+)([:-]) (.*)$/
const GREP_NOTE = /^\[.*\]$/

/**
 * Parse `grep`'s grouped output (see `format_grep_groups` in the agent-tools
 * plugin): a path header per file, then `  N: text` matches and `  N- text`
 * context lines, `  --` marking a gap. Returns undefined when the text is not
 * in that shape (an error, "No matches.", or an older flat result), so the
 * caller falls back to plain text.
 */
export function parseGrepOutput(text: string): GrepOutput | undefined {
  const groups: GrepGroup[] = []
  const notes: string[] = []
  let current: GrepGroup | undefined
  for (const raw of text.split('\n')) {
    if (raw === '') {
      current = undefined
      continue
    }
    if (GREP_NOTE.test(raw)) {
      notes.push(raw.slice(1, -1))
      current = undefined
      continue
    }
    if (raw.startsWith('  ')) {
      if (!current) return undefined
      if (raw === '  --') {
        current.gaps.push(current.lines.length)
        continue
      }
      const m = GREP_LINE.exec(raw)
      if (!m) return undefined
      current.lines.push({ line: Number(m[1]), match: m[2] === ':', text: m[3] })
      continue
    }
    if (current) return undefined
    current = { file: raw, lines: [], gaps: [] }
    groups.push(current)
  }
  if (groups.length === 0 || groups.some((g) => g.lines.length === 0)) {
    return undefined
  }
  return { groups, notes }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The grep pattern as a JS regex for highlighting. The backend uses Rust's
 * regex syntax, which mostly overlaps; anything JS cannot compile (inline flags,
 * Rust-only classes) yields undefined and results render unhighlighted. Patterns
 * that can match the empty string are rejected too: they would highlight nothing
 * useful and can loop.
 */
export function grepHighlightRegex(
  pattern: string,
  opts: { literal: boolean; ignoreCase: boolean }
): RegExp | undefined {
  if (!pattern) return undefined
  try {
    const re = new RegExp(
      opts.literal ? escapeRegExp(pattern) : pattern,
      opts.ignoreCase ? 'gi' : 'g'
    )
    if (re.test('')) return undefined
    re.lastIndex = 0
    return re
  } catch {
    return undefined
  }
}

/** Split `text` into alternating plain/matched runs for `re`. */
export function splitGrepMatches(
  text: string,
  re: RegExp | undefined
): { text: string; hit: boolean }[] {
  if (!re) return [{ text, hit: false }]
  const parts: { text: string; hit: boolean }[] = []
  let last = 0
  re.lastIndex = 0
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0
    if (m[0] === '') continue
    if (start > last) parts.push({ text: text.slice(last, start), hit: false })
    parts.push({ text: m[0], hit: true })
    last = start + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false })
  return parts.length ? parts : [{ text, hit: false }]
}
