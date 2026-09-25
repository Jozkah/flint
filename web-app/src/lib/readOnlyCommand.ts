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
  // Not `sort`: under cmd and bash that is the real program, whose
  // `/O` / `-o<file>` writes a file.
  'sort-object',
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

/**
 * Programs whose `--version` is asked often enough to be worth skipping the
 * prompt for. A fixed list, not "any bare name": cmd.exe looks in the
 * current folder first, so `install.bat --version` would run a script from
 * the project, and `-v` is "verbose" as often as "version".
 *
 * `git` is not here and none of its subcommands are allowlisted: `status`
 * runs `core.fsmonitor` and `diff`/`show` run `diff.external` and textconv
 * drivers, all taken from the repository's own config.
 */
const VERSION_TOOLS: ReadonlySet<string> = new Set([
  'node',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'bun',
  'deno',
  'python',
  'python3',
  'py',
  'pip',
  'cargo',
  'rustc',
  'go',
  'dotnet',
  'java',
  'javac',
  'git',
  'pwsh',
  'powershell',
  'uv',
])

/**
 * Anything that redirects, substitutes, groups, escapes or calls: `>`/`<`,
 * `$(`, backticks, braces (script blocks, hashtables), parentheses, a lone
 * `&` (call operator or background), line breaks, and `\\`/`//`: a UNC path
 * (`Get-Content \\host\share\x`) opens an SMB connection that leaks the
 * Windows login hash.
 */
const UNSAFE_SYNTAX = /[<>`{}()\r\n]|\$\(|(^|[^&])&(?!&)|\\\\|\/\//

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

  if (READ_ONLY_COMMANDS.has(first)) return true

  // `<tool> --version`, for a known tool only, and nothing else.
  return (
    words.length === 2 &&
    VERSION_TOOLS.has(first) &&
    words[1] === '--version'
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
