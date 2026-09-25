/**
 * The kind of a tool call, for its card's colour.
 *
 * A transcript of tool calls reads faster when a read, a search, a shell
 * command and an edit look different at a glance. The kind picks one hue per
 * family (styles/chat.css: `[data-tool-kind]`), which reaches the card's left
 * edge, its icon tile, its status text and the dot on the timeline rail.
 * Colour stays the second signal: every card still says what it did in words.
 */
export type ToolKind =
  | 'read'
  | 'search'
  | 'web'
  | 'bash'
  | 'edit'
  | 'todo'
  | 'fail'
  /** A command that ran and exited non-zero: a failed check, not a crash. */
  | 'warn'
  | 'appr'
  | 'other'

export type ToolKindInput = {
  /** Bare tool name, e.g. `read` -- not the `tool-read` part type. */
  name: string
  /** The AI SDK part state. */
  state?: string
  /** Where the tool came from (web provider, workspace, MCP server). */
  origin?: string
  /** A permission request for this call is waiting on the user. */
  awaitingApproval?: boolean
  /** A command that ran and exited non-zero (see `ToolKind` `warn`). */
  checkFailed?: boolean
}

const WEB = /^web_|^fetch$|browser/
const SEARCH = /grep|glob|search|find|list_dir|^ls$/
const BASH = /bash|shell|command|terminal|exec|run_/
const EDIT = /edit|write|create|patch|delete|move|rename|replace/
const TODO = /todo/
const READ = /read|open|view|cat|get_file/

export function toolKind({
  name,
  state,
  origin,
  awaitingApproval,
  checkFailed,
}: ToolKindInput): ToolKind {
  // What needs the user, then what went wrong, outrank what the tool is.
  if (awaitingApproval) return 'appr'
  if (state === 'output-error' || state === 'output-denied') return 'fail'
  if (checkFailed) return 'warn'
  const n = name.toLowerCase()
  if (WEB.test(n) || origin === 'Web') return 'web'
  if (TODO.test(n)) return 'todo'
  if (SEARCH.test(n)) return 'search'
  if (BASH.test(n)) return 'bash'
  if (EDIT.test(n)) return 'edit'
  if (READ.test(n)) return 'read'
  return 'other'
}
