/**
 * Turn a conversation into Markdown, or Obsidian-flavoured Markdown.
 *
 * Pure: nothing is read from a store, the clock or the disk, so the same
 * `ExportDoc` always renders the same text. The document is built from a chat
 * thread, a Cowork session or a single message by `exportDoc.ts`; the file is
 * written by `exportFile.ts`.
 *
 * Two views. The default reads like a conversation: tool calls are one line
 * each, reasoning is left out, and absolute paths from this machine are cut
 * down to the file name. The verbose view adds tool inputs and outputs and the
 * reasoning, and keeps paths as they were.
 */
import { parseFileRefs } from '@/lib/coworkFileRefs'

export type ExportScope = 'thread' | 'branch' | 'session' | 'message'

export type ExportView = 'default' | 'verbose'

export type ExportTool = {
  name: string
  input?: unknown
  output?: unknown
  isError?: boolean
}

export type ExportMessage = {
  role: 'user' | 'assistant' | 'system'
  text: string
  reasoning?: string
  /** Names of files attached to the message. */
  files?: string[]
  /** How many images were attached; their data is never exported. */
  images?: number
  tools?: ExportTool[]
  /**
   * Other versions of this message (an edit or a regeneration), each with what
   * followed it. Nested under the message in the output.
   */
  alternatives?: ExportMessage[][]
  /** Epoch milliseconds. */
  at?: number
}

export type ExportDoc = {
  title: string
  scope: ExportScope
  /** ISO 8601, supplied by the caller so rendering stays pure. */
  exportedAt: string
  model?: string
  /** Which branch of a branched thread this is, 1-based. */
  branch?: { index: number; count: number }
  messages: ExportMessage[]
}

export type RenderOptions = { view?: ExportView }

const ROLE_LABEL: Record<ExportMessage['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
}

const SCOPE_TAG: Record<ExportScope, string> = {
  thread: 'chat',
  branch: 'chat',
  session: 'cowork',
  message: 'message',
}

const SCOPE_TYPE: Record<ExportScope, string> = {
  thread: 'chat',
  branch: 'chat-branch',
  session: 'cowork-session',
  message: 'chat-message',
}

const EMPTY_NOTE = '_This conversation is empty._'

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * A file name that is legal on Windows, macOS and Linux: illegal characters
 * and control characters replaced, trailing dots and spaces dropped, reserved
 * device names defused, length bounded. The backend sanitizes again.
 */
export function exportFileName(
  title: string,
  ext: 'md' | 'pdf' | 'png' | 'html'
): string {
  let stem = (title ?? '')
    .replace(/[<>:"/\\|?*]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
  const suffix = `.${ext}`
  if (stem.toLowerCase().endsWith(suffix)) stem = stem.slice(0, -suffix.length)
  stem = stem.replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '')
  stem = Array.from(stem).slice(0, 80).join('').replace(/[. ]+$/g, '')
  if (!stem) stem = 'export'
  if (RESERVED_NAMES.test(stem)) stem = `_${stem}`
  return `${stem}${suffix}`
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// A Windows drive path, or a path under a well-known POSIX root. Anchored to a
// boundary so a URL's path (`https://host/home/x`) is never touched.
const WIN_ABS = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\s"'`<>|*?\\/]+[\\/])*[^\s"'`<>|*?\\/]*/g
const POSIX_ABS =
  /(?<![A-Za-z0-9_.:/\\-])\/(?:home|Users|root|var|tmp|opt|etc|mnt|private|srv|usr)\/(?:[^\s"'`<>|*?/]+\/)*[^\s"'`<>|*?/]*/g

/** Cut an absolute path down to its last segment: `C:\a\b\c.ts` becomes `c.ts`. */
export function stripAbsolutePaths(text: string): string {
  const base = (m: string) => {
    const last = m.split(/[\\/]/).filter(Boolean).pop()
    return last && !/^[A-Za-z]:$/.test(last) ? last : '[path]'
  }
  return text.replace(WIN_ABS, base).replace(POSIX_ABS, base)
}

/** A fence long enough that nothing inside can close it. */
function fenced(body: string, lang = ''): string {
  let longest = 0
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${body}\n${fence}`
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function visible(text: string, view: ExportView): string {
  return view === 'verbose' ? text : stripAbsolutePaths(text)
}

function stamp(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return ''
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16)
}

/** Map a function over the parts of `text` that are outside code fences. */
function outsideFences(text: string, fn: (part: string) => string): string {
  return text
    .split(/(^```[\s\S]*?^```[^\n]*$|^~~~[\s\S]*?^~~~[^\n]*$)/m)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('')
}

/** `@src/a.ts:12` becomes `[[src/a.ts]]`, the way Obsidian links a note. */
function wikilinkRefs(text: string): string {
  return outsideFences(text, (part) =>
    parseFileRefs(part)
      .map((seg) => (seg.type === 'ref' ? `[[${seg.ref.path}]]` : seg.text))
      .join('')
  )
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

type Flavor = 'plain' | 'obsidian'

function toolLine(tool: ExportTool): string {
  return `- Used \`${tool.name.replace(/`/g, "'")}\`${tool.isError ? ' (failed)' : ''}`
}

function renderTool(tool: ExportTool, view: ExportView): string {
  if (view !== 'verbose') return toolLine(tool)
  const out = [`**Tool: \`${tool.name.replace(/`/g, "'")}\`**${tool.isError ? ' (failed)' : ''}`]
  const input = stringify(tool.input)
  if (input) out.push('Input:', fenced(input, 'json'))
  const output = stringify(tool.output)
  if (output) out.push('Output:', fenced(output))
  return out.join('\n\n')
}

function renderMessage(
  m: ExportMessage,
  view: ExportView,
  flavor: Flavor
): string {
  const when = stamp(m.at)
  const parts: string[] = [`## ${ROLE_LABEL[m.role]}${when ? ` · ${when}` : ''}`]

  if (view === 'verbose' && m.reasoning?.trim()) {
    parts.push(
      `<details>\n<summary>Reasoning</summary>\n\n${m.reasoning.trim()}\n\n</details>`
    )
  }

  let text = m.text.trim()
  if (text) {
    text = visible(text, view)
    if (flavor === 'obsidian') text = wikilinkRefs(text)
    parts.push(text)
  }

  if (m.files?.length) {
    const names = m.files.map((f) =>
      flavor === 'obsidian' ? `[[${f}]]` : `\`${f.replace(/`/g, "'")}\``
    )
    parts.push(`Attached: ${names.join(', ')}`)
  }
  if (m.images) {
    parts.push(`_${m.images} image${m.images === 1 ? '' : 's'} attached_`)
  }

  const tools = m.tools ?? []
  if (tools.length) {
    if (view === 'verbose') {
      parts.push(...tools.map((t) => renderTool(t, view)))
    } else {
      parts.push(tools.map((t) => visible(toolLine(t), view)).join('\n'))
    }
  }

  if (parts.length === 1) parts.push('_(no text)_')
  m.alternatives?.forEach((alt, i) => {
    const inner = alt.map((x) => renderMessage(x, view, flavor)).join('\n\n')
    const quoted = inner
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n')
    parts.push(`> **Other version ${i + 1} of this message**\n>\n${quoted}`)
  })
  return parts.join('\n\n')
}

function header(doc: ExportDoc): string {
  const line = ['Exported from Flint', doc.exportedAt.slice(0, 10)]
  if (doc.model) line.push(oneLine(doc.model))
  if (doc.branch) line.push(`Branch ${doc.branch.index} of ${doc.branch.count}`)
  return `> ${line.join(' · ')}`
}

function body(doc: ExportDoc, view: ExportView, flavor: Flavor): string {
  const blocks = doc.messages.length
    ? doc.messages.map((m) => renderMessage(m, view, flavor))
    : [EMPTY_NOTE]
  return blocks.join('\n\n---\n\n')
}

function heading(doc: ExportDoc): string {
  return `# ${oneLine(doc.title) || 'Untitled'}`
}

/** Plain Markdown: a heading, a one-line provenance note, then the turns. */
export function renderMarkdown(
  doc: ExportDoc,
  options: RenderOptions = {}
): string {
  const view = options.view ?? 'default'
  return `${heading(doc)}\n\n${header(doc)}\n\n${body(doc, view, 'plain')}\n`
}

// ---------------------------------------------------------------------------
// Obsidian
// ---------------------------------------------------------------------------

/** A YAML double-quoted scalar. JSON string syntax is a subset of it. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

/** One tag segment: no spaces, no `#`, nothing Obsidian would split on. */
function tagSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Obsidian Markdown: YAML frontmatter (title, dates, type, model, tags),
 * `@path` references turned into `[[wikilinks]]` and attachments linked by
 * name.
 */
export function renderObsidian(
  doc: ExportDoc,
  options: RenderOptions = {}
): string {
  const view = options.view ?? 'default'
  const tags = ['flint', `flint/${SCOPE_TAG[doc.scope]}`]
  const front = [
    '---',
    `title: ${yamlString(oneLine(doc.title) || 'Untitled')}`,
    `created: ${yamlString(doc.exportedAt)}`,
    'source: Flint',
    `type: ${SCOPE_TYPE[doc.scope]}`,
  ]
  if (doc.model) front.push(`model: ${yamlString(oneLine(doc.model))}`)
  front.push(`messages: ${doc.messages.length}`)
  if (doc.branch) front.push(`branch: ${doc.branch.index}`, `branches: ${doc.branch.count}`)
  front.push('tags:')
  for (const tag of tags) {
    const clean = tag.split('/').map(tagSegment).filter(Boolean).join('/')
    if (clean) front.push(`  - ${clean}`)
  }
  front.push('---')
  return `${front.join('\n')}\n\n${heading(doc)}\n\n${body(doc, view, 'obsidian')}\n`
}
