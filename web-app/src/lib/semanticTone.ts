/**
 * A restrained amount of colour in the transcript.
 *
 * The point is to make a row's *kind* legible at a glance — a file write is
 * not a file read, an MCP call is not a built-in tool — without turning the
 * conversation into a rainbow. So a tone reaches an icon, a thin border and
 * at most a very faint surface; never a filled block of colour.
 *
 * Colour is always the second signal. Every row keeps its status text and its
 * icon shape, so nothing here is the only way to tell what happened.
 *
 * Pairs are written light/dark explicitly rather than relying on a single
 * palette step, which is legible on one ground and not the other.
 */

export type SemanticTone =
  /** The person talking. */
  | 'user'
  /** The model talking: deliberately neutral, since it is most of the page. */
  | 'assistant'
  /** A built-in tool call. */
  | 'tool'
  /** A tool served by an MCP server — related to `tool`, distinguishable. */
  | 'mcp'
  /** Looking at something: read, list, search, fetch. */
  | 'read'
  /** Changing something: write, edit, delete, move. */
  | 'write'
  /** It finished, and it worked. */
  | 'success'
  /** It failed. */
  | 'error'
  /** Work happening off to one side. */
  | 'subagent'

export type ToneClasses = {
  /** The row's icon. This is where the tone usually lives. */
  icon: string
  /** A hairline, for rows that need an edge. */
  border: string
  /** Barely-there fill. Must stay readable under body text. */
  surface: string
  /** Small pill text, e.g. an origin or a state badge. */
  badge: string
}

export const TONE_CLASSES: Record<SemanticTone, ToneClasses> = {
  user: {
    icon: 'text-primary/70',
    border: 'border-primary/20',
    surface: 'bg-primary/[0.04] dark:bg-primary/[0.07]',
    badge: 'text-primary/80',
  },
  assistant: {
    icon: 'text-muted-foreground',
    border: 'border-border',
    surface: '',
    badge: 'text-muted-foreground',
  },
  tool: {
    icon: 'text-indigo-600 dark:text-indigo-400',
    border: 'border-indigo-500/20',
    surface: 'bg-indigo-500/[0.04] dark:bg-indigo-400/[0.06]',
    badge: 'text-indigo-600/80 dark:text-indigo-400/80',
  },
  mcp: {
    icon: 'text-violet-600 dark:text-violet-400',
    border: 'border-violet-500/20',
    surface: 'bg-violet-500/[0.04] dark:bg-violet-400/[0.06]',
    badge: 'text-violet-600/80 dark:text-violet-400/80',
  },
  read: {
    icon: 'text-cyan-700 dark:text-cyan-400',
    border: 'border-cyan-500/20',
    surface: 'bg-cyan-500/[0.04] dark:bg-cyan-400/[0.06]',
    badge: 'text-cyan-700/80 dark:text-cyan-400/80',
  },
  write: {
    icon: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-500/25',
    surface: 'bg-amber-500/[0.05] dark:bg-amber-400/[0.07]',
    badge: 'text-amber-600/80 dark:text-amber-400/80',
  },
  success: {
    icon: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-500/20',
    surface: 'bg-emerald-500/[0.04] dark:bg-emerald-400/[0.06]',
    badge: 'text-emerald-600/80 dark:text-emerald-400/80',
  },
  error: {
    icon: 'text-destructive',
    border: 'border-destructive/30',
    surface: 'bg-destructive/[0.05] dark:bg-destructive/[0.08]',
    badge: 'text-destructive',
  },
  subagent: {
    icon: 'text-secondary-foreground/70',
    border: 'border-secondary-foreground/20',
    surface: 'bg-secondary/40',
    badge: 'text-secondary-foreground/70',
  },
}

/** Tools that only look. */
const READING = new Set([
  'read',
  'ls',
  'find',
  'grep',
  'search',
  'web_search',
  'web_fetch',
  'project_list_dir',
  'project_read_file',
])

/** Tools that change something on disk. */
const WRITING = new Set([
  'write',
  'edit',
  'create',
  'delete',
  'move',
  'rename',
  'apply_patch',
])

export type ToolToneInput = {
  /** Bare tool name, e.g. `read` — not the `tool-read` part type. */
  name: string
  /** The AI SDK part state. */
  state?: string
  /** Where the tool came from; an MCP server name marks it as MCP. */
  origin?: string
  /** The tool is an MCP server's, whatever its name looks like. */
  isMcp?: boolean
  /** Run by a subagent rather than the main agent. */
  isSubagent?: boolean
}

/**
 * The tone for one tool row.
 *
 * Failure outranks the tool's kind: what went wrong matters more than which
 * tool it was. Success does not — every finished tool taking green would make
 * a settled transcript a wall of it, and would erase the distinction between
 * a file that was read and a file that was rewritten. Success is carried by
 * the row's existing status text; colour keeps saying what kind of work it
 * was. The single exception is a write, which stops being urgent once done.
 */
export function toneForTool(input: ToolToneInput): SemanticTone {
  const state = input.state ?? ''
  if (state === 'output-error') return 'error'

  const running = state === 'input-streaming' || state === 'input-available'

  // A write in flight is the one case worth flagging while it happens: it is
  // changing the user's files right now. Once it settles it is no longer
  // urgent, but it is still a write — colouring it green would lose that.
  if (WRITING.has(input.name)) return running ? 'write' : 'success'

  if (input.isSubagent) return 'subagent'
  if (input.isMcp || (input.origin && !READING.has(input.name)))
    return isBuiltIn(input.name) ? 'tool' : 'mcp'
  if (READING.has(input.name)) return 'read'
  return 'tool'
}

/** Names the app ships itself, so an `origin` on one is not an MCP server. */
const BUILT_IN = new Set([
  ...READING,
  ...WRITING,
  'ask',
  'todo_write',
  'bash',
  'memory_read',
  'memory_write',
  'skill_read',
])

const isBuiltIn = (name: string): boolean => BUILT_IN.has(name)

/** Convenience for the common case of styling just the icon. */
export const toneIcon = (tone: SemanticTone): string => TONE_CLASSES[tone].icon
