/**
 * Is a shell line obviously read-only, so "Ask before changes" need not ask?
 *
 * A run that inspects a project before changing it (listing folders, reading
 * files, checking tool versions, `git status`) was stopping for an approval on
 * every probe. This recognises the plain forms of those probes and nothing
 * else: anything it is not sure about still asks. It is deliberately
 * conservative -- a false "no" costs one click, a false "yes" runs a command
 * nobody approved.
 *
 * A line qualifies only when every command in it (split on `;`, `|`, `&&`,
 * `||`) starts with an allowlisted command, and the line has no redirection,
 * no subexpression, script block, call operator or other way of running
 * something the first word does not name.
 */

/** Commands that only read, lowercased. Aliases included on purpose. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  // Listing and reading
  'get-childitem',
  'ls',
  'dir',
  'gci',
  'get-content',
  'cat',
  'type',
  'gc',
  'head',
  'tail',
  'wc',
  'get-item',
  'test-path',
  'resolve-path',
  // Locating commands
  'get-command',
  'gcm',
  'where.exe',
  'which',
  // Searching
  'select-string',
  'sls',
  'rg',
  'grep',
  // Where am I
  'get-location',
  'pwd',
  'gl',
  // Printing
  'echo',
  'write-output',
  'write-host',
  // Shaping piped output (no script blocks: those are refused below)
  'select-object',
  'select',
  'sort-object',
  'sort',
  'measure-object',
  'measure',
  'format-table',
  'ft',
  'format-list',
  'fl',
  'out-string',
  'where-object',
  'where',
])

/** `git` subcommands that only read. */
const READ_ONLY_GIT: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'show',
])

const VERSION_FLAGS: ReadonlySet<string> = new Set([
  '--version',
  '-v',
  '-V',
  'version',
])

/**
 * Anything that redirects, substitutes, groups, escapes or calls: `>`/`<`,
 * `$(`, backticks, braces (script blocks, hashtables), parentheses, a lone
 * `&` (call operator or background), and line breaks.
 */
const UNSAFE_SYNTAX = /[<>`{}()\r\n]|\$\(|(^|[^&])&(?!&)/

/** Words that write, create, delete, or run something else, anywhere. */
const UNSAFE_WORDS =
  /\b(out-file|set-content|add-content|tee-object|tee|remove-\w*|new-\w*|copy-\w*|move-\w*|rename-\w*|set-\w*|clear-\w*|invoke-\w*|iex|start-process|start-job|saps)\b/i

/** Flags of allowlisted tools that write a file or run a program. */
const UNSAFE_FLAGS = /(^|\s)(--output|--pre|--ext-diff|-o|--exec|-exec)(=|\s|$)/i

const tokens = (segment: string): string[] =>
  segment.trim().split(/\s+/).filter(Boolean)

function segmentIsReadOnly(segment: string): boolean {
  const words = tokens(segment)
  if (words.length === 0) return false
  const first = words[0].toLowerCase()

  if (first === 'git') {
    // Only `git <subcommand> ...`, optionally after `--no-pager`: an option
    // before the subcommand (`-c core.pager=...`) can run a program.
    let i = 1
    if (words[i]?.toLowerCase() === '--no-pager') i++
    return READ_ONLY_GIT.has(words[i]?.toLowerCase() ?? '')
  }

  if (READ_ONLY_COMMANDS.has(first)) return true

  // `<tool> --version`: a bare program name and one version flag, nothing
  // else. A path (`.\x.ps1 --version`) is not a bare name and still asks.
  return (
    words.length === 2 &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(words[0]) &&
    VERSION_FLAGS.has(words[1])
  )
}

export function isReadOnlyCommand(command: string): boolean {
  const line = command.trim()
  if (!line) return false
  if (UNSAFE_SYNTAX.test(line)) return false
  if (UNSAFE_WORDS.test(line)) return false
  if (UNSAFE_FLAGS.test(line)) return false
  return line.split(/&&|\|\||;|\|/).every(segmentIsReadOnly)
}
