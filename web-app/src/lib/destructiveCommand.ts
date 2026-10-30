/**
 * Destructive shell command detection, run before `bash` executes.
 *
 * A match does not refuse the command: it forces the approval prompt even when
 * the session would otherwise run it unasked (auto mode, a standing grant), so
 * a person sees `rm -rf ~` before it runs rather than after. False positives
 * cost one click. A command the checker cannot see through -- an unbalanced
 * quote, `eval`, `Invoke-Expression`, a PowerShell `-EncodedCommand`,
 * `xargs rm` -- is asked about too, never silently allowed.
 *
 * Port of `src-tauri/src/core/agent/destructive.rs`. The rule data and the
 * shared test vectors live in `destructiveCommandRules.json`, which the Rust
 * side includes as well; both runtimes run every vector in it, so the two
 * cannot drift without a test failing.
 */

import rules from './destructiveCommandRules.json'

type Rules = {
  wrappers: string[]
  wrapperValueOptions: Record<string, string[]>
  wrapperPositional: Record<string, number>
  inlineShells: string[]
  powershells: string[]
  /** Interpreters and the options that run code given on the command line. */
  inlineInterpreters: Record<string, string[]>
  uncertainCommands: Record<string, string>
  alwaysAskCommands: Record<string, string>
  deleteCommands: string[]
  sqlPhrases: string[]
}

const RULES = rules as unknown as Rules

/** How deep `bash -c`, `cmd /c` and `$(...)` may nest before we give up. */
const MAX_DEPTH = 4

const isDrive = (a: string) => /^[a-zA-Z]:$/.test(a)

/** One simple command; `piped` when a single `|` fed it. */
type Seg = { words: string[]; piped: boolean }
type Parsed = { segments: Seg[]; substitutions: string[] }

/**
 * Split into simple commands on `;`, `&`, `&&`, `||`, `|`, newlines (POSIX
 * shells, PowerShell, cmd.exe), then words; collect `$(...)`, `` `...` `` and
 * `<(...)` bodies. Throws on an unclosed quote or substitution.
 */
function parse(command: string, posixEscapes: boolean): Parsed {
  const out: Parsed = { segments: [], substitutions: [] }
  let pendingPipe = false
  let words: string[] = []
  let cur = ''
  let quote: string | null = null
  const flush = () => {
    if (cur) {
      words.push(cur)
      cur = ''
    }
  }
  let i = 0
  while (i < command.length) {
    const c = command[i]
    // POSIX reading: `\x` makes `x` literal, so `\"` neither opens a quote nor
    // hides what follows. Backslashes before anything else stay literal (a
    // Windows path). Both readings are checked; see `reasonAtDepth`.
    if (
      posixEscapes &&
      c === '\\' &&
      quote !== "'" &&
      i + 1 < command.length &&
      '"\'; |&`$\\'.includes(command[i + 1])
    ) {
      cur += command[i + 1]
      i += 2
      continue
    }
    if (quote !== "'") {
      const opensParen =
        (c === '$' || (quote === null && (c === '<' || c === '>'))) &&
        command[i + 1] === '('
      if (opensParen) {
        let depth = 1
        let j = i + 2
        while (j < command.length && depth > 0) {
          if (command[j] === '(') depth++
          else if (command[j] === ')') depth--
          j++
        }
        if (depth > 0) throw new Error('unclosed `$(`')
        out.substitutions.push(command.slice(i + 2, j - 1))
        cur += command.slice(i, j)
        i = j
        continue
      }
      if (c === '`') {
        const end = command.indexOf('`', i + 1)
        if (end !== -1) {
          out.substitutions.push(command.slice(i + 1, end))
          cur += command.slice(i, end + 1)
          i = end + 1
          continue
        }
        // A lone backtick: PowerShell's escape character. Literal.
      }
    }
    if (quote) {
      if (c === quote) quote = null
      else cur += c
    } else if (c === '"' || c === "'") quote = c
    else if (c === ' ' || c === '\t' || c === '\r') flush()
    else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      flush()
      const isPipe = c === '|' && command[i + 1] !== '|'
      if ((c === '|' || c === '&') && command[i + 1] === c) i++
      if (words.length) {
        out.segments.push({ words, piped: pendingPipe })
        words = []
        pendingPipe = isPipe
      } else pendingPipe ||= isPipe
    } else cur += c
    i++
  }
  if (quote) throw new Error('unbalanced quote')
  flush()
  if (words.length) out.segments.push({ words, piped: pendingPipe })
  return out
}

function stripPrefixes(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]
    const assignment =
      w.includes('=') && !w.startsWith('-') && !w.startsWith('=')
    if (assignment) {
      i++
      continue
    }
    if (!RULES.wrappers.includes(w)) break
    i++
    // Options, and the value of those that take one as a separate word
    // (`sudo -u root`, `nice -n 10`). `-u=x` and `-ux` are one word.
    const valueOptions = RULES.wrapperValueOptions[w] ?? []
    while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
      i += valueOptions.includes(words[i]) ? 2 : 1
    }
    i += RULES.wrapperPositional[w] ?? 0
  }
  return words.slice(Math.min(i, words.length))
}

/** The command name a word invokes: no directory, no `.exe`, lowercase. */
const INLINE_CODE = 'runs code given on the command line, which cannot be checked'

/**
 * Whether an interpreter's options (those before the script name) include one
 * that runs code from the command line, as `-c` or `--eval=...`.
 */
function runsInlineCode(args: string[], flags: readonly string[]): boolean {
  for (const arg of args) {
    if (!arg.startsWith('-')) return false
    if (flags.some((f) => arg === f || arg.startsWith(`${f}=`))) return true
  }
  return false
}

function commandName(word: string): string {
  const base = word.toLowerCase().split(/[/\\]/).pop() ?? ''
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}

/**
 * The folders a command may delete inside without being asked about. Empty is
 * the unknown scope: every absolute path counts as outside it.
 */
export type DeletionScope = readonly string[]

const isAbsolutePath = (p: string) =>
  p.startsWith('/') || (isDrive(p.slice(0, 2)) && p[2] === '/')

/**
 * A path in the form roots and targets are compared in: `/` separators, no
 * verbatim `\\?\` prefix, no `.` segments or repeated or trailing separators,
 * case-folded when it is a drive path. `null` when it holds `..`: text alone
 * cannot tell where that leads once symlinks are involved, so it is never
 * treated as inside. (The desktop resolves through the filesystem instead;
 * see `agent_destructive_reason`.)
 */
function comparablePath(path: string): string | null {
  let p = path.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '')
  p = p.replace(/\\/g, '/')
  const unc = p.startsWith('//')
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  const drive = parts.length > 0 && isDrive(parts[0])
  const joined = drive
    ? parts.join('/')
    : `${unc ? '//' : '/'}${parts.join('/')}`
  return drive ? joined.toLowerCase() : joined
}

/** Absolute roots in comparable form; `/` or a bare drive vouches for nothing. */
function scopeRoots(scope: DeletionScope): string[] {
  const out: string[] = []
  for (const raw of scope) {
    const slashed = raw
      .replace(/^\\\\\?\\UNC\\/, '\\\\')
      .replace(/^\\\\\?\\/, '')
      .replace(/\\/g, '/')
    if (!isAbsolutePath(slashed)) continue
    const root = comparablePath(slashed)
    if (!root || root === '/' || root === '//' || isDrive(root)) continue
    out.push(root)
  }
  return out
}

/**
 * A deletion target that reaches beyond the approved scope: the filesystem
 * root, home, a parent directory, an unresolved variable or substitution, a
 * drive-relative path, or an absolute path not under any root of `workspace`
 * (a single root or several). An empty scope makes every absolute path
 * outside. A sibling folder that merely starts with a root's name
 * (`/proj-other` beside `/proj`) is outside.
 */
export function outsideWorkspace(
  target: string,
  workspace: string | DeletionScope,
  /** An earlier `cd` left the workspace: relative targets are outside too. */
  cwdUnknown = false
): boolean {
  const t = target.replace(/^["']+|["']+$/g, '')
  if (!t) return false
  if (/^[~$%`]/.test(t)) return true
  // A variable, substitution or brace expansion anywhere in the path.
  if (/[$%`{]/.test(t)) return true
  const norm = t.replace(/\\/g, '/')
  // `C:foo` is relative to that drive's current directory, which is unknown.
  if (isDrive(norm.slice(0, 2)) && !isAbsolutePath(norm)) return true
  if (!isAbsolutePath(norm)) {
    return (
      cwdUnknown ||
      norm === '..' ||
      norm.startsWith('../') ||
      norm.includes('/../') ||
      norm.endsWith('/..')
    )
  }
  const n = comparablePath(norm.replace(/[/*]+$/, '') || '/')
  if (n === null) return true
  const ci = isDrive(n.slice(0, 2))
  const roots = scopeRoots(
    typeof workspace === 'string' ? [workspace] : workspace
  )
  return !roots.some((root) => {
    const r = ci ? root.toLowerCase() : root
    return n === r || n.startsWith(`${r}/`)
  })
}

/** Recursive?, and the targets. POSIX flags and PowerShell parameters. */
function deletionFlags(
  args: string[],
  cmdSwitches: boolean
): {
  recursive: boolean
  targets: string[]
} {
  let recursive = false
  const targets: string[] = []
  for (const a of args) {
    const lower = a.toLowerCase()
    if (lower === '--recursive') recursive = true
    else if (
      lower.startsWith('--') ||
      (cmdSwitches && /^\/[a-zA-Z]$/.test(a))
    ) {
      // Other long options, and cmd switches like `/q`.
    } else if (a.startsWith('-')) {
      const body = a.slice(1)
      if (body && /^[rRfivdI]+$/.test(body)) recursive ||= /[rR]/.test(body)
      else recursive ||= lower.startsWith('-rec')
    } else targets.push(a)
  }
  return { recursive, targets }
}

function gitSubcommand(lower: string[]): number {
  let i = 0
  while (i < lower.length) {
    const a = lower[i]
    if (['-c', '--git-dir', '--work-tree', '--namespace'].includes(a)) i += 2
    else if (a.startsWith('-')) i++
    else return i
  }
  return -1
}

function xargsCommand(args: string[]): string | undefined {
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a'].includes(a)) i += 2
    else if (a.startsWith('-')) i++
    else return a
  }
  return undefined
}

function outsideReason(words: string[], target: string, verb: string): string {
  return `\`${words.join(' ')}\` ${verb} \`${target}\`, outside the workspace`
}

/** The approved roots, and whether a `cd` has left them. */
type Scope = { roots: DeletionScope; cwdUnknown: boolean }

const outside = (target: string, scope: Scope) =>
  outsideWorkspace(target, scope.roots, scope.cwdUnknown)

function firstOutside(targets: string[], scope: Scope): string | undefined {
  return (targets.length ? targets : ['.']).find((t) => outside(t, scope))
}

/**
 * Whether this segment moves the shell to a directory not known to be inside
 * `scope`: `cd`/`pushd`/`Set-Location` to an outside, home or unresolvable
 * target, a bare `cd` (home), `cd -`, or `popd`.
 */
function changesToUnknownDir(words: string[], scope: Scope): boolean {
  switch (commandName(words[0])) {
    case 'popd':
    case 'pop-location':
      return true
    case 'cd':
    case 'chdir':
    case 'pushd':
    case 'set-location':
    case 'sl':
    case 'push-location': {
      const target = words
        .slice(1)
        .filter((a) => !a.startsWith('-') && !/^\/[a-zA-Z]$/.test(a))
        .pop()
      if (target === undefined) return true
      const t = target.replace(/^["']+|["']+$/g, '')
      return t === '' || t === '-' || outside(t, scope)
    }
    default:
      return false
  }
}

const READS_INPUT = 'runs a script read from input, which cannot be checked'
const PS_UNCHECKABLE = 'runs a PowerShell command that cannot be checked'
const PS_VALUE_OPTIONS = [
  '-executionpolicy',
  '-ep',
  '-windowstyle',
  '-workingdirectory',
  '-wd',
  '-configurationname',
  '-version',
  '-inputformat',
  '-outputformat',
  '-psconsolefile',
]
const PS_SWITCHES = [
  '-noprofile',
  '-nop',
  '-noexit',
  '-noe',
  '-nologo',
  '-nol',
  '-noninteractive',
  '-noni',
  '-sta',
  '-mta',
]

function checkSegment(
  words: string[],
  workspace: Scope,
  depth: number,
  piped: boolean
): string | null {
  const cmd = commandName(words[0])
  const args = words.slice(1)
  const lower = args.map((a) => a.toLowerCase())

  if (Object.prototype.hasOwnProperty.call(RULES.uncertainCommands, cmd)) {
    return RULES.uncertainCommands[cmd]
  }
  if (Object.prototype.hasOwnProperty.call(RULES.alwaysAskCommands, cmd)) {
    return RULES.alwaysAskCommands[cmd]
  }
  if (Object.prototype.hasOwnProperty.call(RULES.inlineInterpreters, cmd)) {
    if (runsInlineCode(args, RULES.inlineInterpreters[cmd])) return INLINE_CODE
  }
  if (RULES.inlineShells.includes(cmd)) {
    const at = lower.findIndex(
      (a) => a.startsWith('-') && !a.startsWith('--') && a.includes('c')
    )
    if (at === -1 || args[at + 1] === undefined) {
      // The script comes from a pipe, here-doc or here-string, or stdin.
      return piped || lower.some((a) => a.startsWith('<<') || a === '-s')
        ? READS_INPUT
        : null
    }
    return reasonAtDepth(args[at + 1], workspace, depth + 1)
  }
  if (cmd === 'cmd') {
    const at = lower.findIndex((a) => a === '/c' || a === '/k')
    if (at === -1) return piped ? READS_INPUT : null
    return reasonAtDepth(args.slice(at + 1).join(' '), workspace, depth + 1)
  }
  if (RULES.powershells.includes(cmd)) {
    if (
      lower.some(
        (a) =>
          ['-e', '-ec', '-en', '-enc', '-encodedcommand'].includes(a) ||
          a.startsWith('-encodedc')
      )
    ) {
      return 'runs an encoded PowerShell command, which cannot be checked'
    }
    const at = lower.findIndex((a) => a === '-c' || a.startsWith('-com'))
    if (at !== -1) {
      return reasonAtDepth(args.slice(at + 1).join(' '), workspace, depth + 1)
    }
    if (lower.some((a) => a.length >= 2 && '-file'.startsWith(a))) return null
    // `pwsh -NoProfile "Remove-Item ..."`: the first word that is not an option
    // starts the command, and the rest of the line belongs to it.
    for (let k = 0; k < lower.length; k++) {
      const a = lower[k]
      if (!a.startsWith('-')) {
        return reasonAtDepth(args.slice(k).join(' '), workspace, depth + 1)
      }
      if (PS_VALUE_OPTIONS.includes(a)) k++
      else if (!PS_SWITCHES.includes(a)) return PS_UNCHECKABLE
    }
    return piped ? READS_INPUT : null
  }

  switch (cmd) {
    case 'rm':
    case 'unlink':
    case 'shred':
    case 'remove-item':
    case 'ri': {
      // Recursive or not, a target outside the workspace is asked about.
      const { targets } = deletionFlags(args, false)
      const t = targets.find((x) => outside(x, workspace))
      return t ? outsideReason(words, t, 'deletes') : null
    }
    case 'del':
    case 'erase': {
      if (lower.includes('/s')) return '`del /s` deletes recursively'
      const { targets } = deletionFlags(args, true)
      const t = targets.find((x) => outside(x, workspace))
      return t ? outsideReason(words, t, 'deletes') : null
    }
    case 'rd':
    case 'rmdir': {
      const { recursive, targets } = deletionFlags(args, true)
      if (!(lower.includes('/s') || recursive)) return null
      const t = firstOutside(targets, workspace)
      return t ? outsideReason(words, t, 'deletes') : null
    }
    case 'xargs': {
      const inner = xargsCommand(args)
      if (!inner) return null
      const name = commandName(inner)
      return RULES.deleteCommands.includes(name)
        ? `\`xargs ${name}\` deletes paths read from input`
        : null
    }
    case 'find': {
      const deletes = lower.some(
        (a, i) =>
          a === '-delete' ||
          (['-exec', '-execdir', '-ok', '-okdir'].includes(a) &&
            lower[i + 1] !== undefined &&
            RULES.deleteCommands.includes(commandName(lower[i + 1])))
      )
      if (!deletes) return null
      const starts: string[] = []
      let i = 0
      // find's own leading options (-H, -L, -P, -O3, -D debugopts) come
      // before the start points; they must not end the list early.
      while (i < args.length && /^-(?:[HLP]|O\d*)$/.test(args[i])) i++
      if (args[i] === '-D') i += 2
      for (; i < args.length; i++) {
        const a = args[i]
        if (a.startsWith('-') || a === '(' || a === '!') break
        starts.push(a)
      }
      const t = firstOutside(starts, workspace)
      return t ? outsideReason(words, t, 'deletes under') : null
    }
    case 'git': {
      const sub = gitSubcommand(lower)
      if (sub === -1) return null
      const rest = lower.slice(sub + 1)
      const has = (f: string) => rest.includes(f)
      const name = lower[sub]
      if (name === 'reset' && has('--hard')) {
        return '`git reset --hard` discards uncommitted work'
      }
      if (name === 'clean') {
        const short = rest
          .filter((a) => a.startsWith('-') && !a.startsWith('--'))
          .map((a) => a.replace(/^-+/, ''))
          .join('')
        if (short.includes('f') || has('--force')) {
          return '`git clean` deletes untracked files'
        }
      }
      // Original case: `-D`/`-S`/`-W` differ from their lowercase forms.
      const raw = args.slice(sub + 1)
      if (
        name === 'checkout' &&
        (has('--') ||
          has('.') ||
          has('--force') ||
          rest.some(
            (a) => /^-[a-z]*f[a-z]*$/.test(a) || a.startsWith('--pathspec-from-file')
          ))
      ) {
        return '`git checkout` of paths discards uncommitted changes'
      }
      if (name === 'restore') {
        const staged = raw.includes('--staged') || raw.includes('-S')
        const worktree = raw.includes('--worktree') || raw.includes('-W')
        if (!staged || worktree) {
          return '`git restore` discards uncommitted changes'
        }
      }
      if (
        name === 'branch' &&
        (raw.some((a) => /^-[a-zA-Z]*D[a-zA-Z]*$/.test(a)) ||
          (has('--delete') &&
            (has('--force') || rest.some((a) => /^-[a-z]*f[a-z]*$/.test(a)))))
      ) {
        return '`git branch -D` deletes a branch that may be unmerged'
      }
      if (name === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) {
        return '`git stash drop` discards stashed changes'
      }
      if (
        name === 'rebase' &&
        !has('--continue') &&
        !has('--abort') &&
        !has('--quit')
      ) {
        return '`git rebase` rewrites history'
      }
      if (name === 'filter-branch' || name === 'filter-repo') {
        return `\`git ${name}\` rewrites history`
      }
      if (
        name === 'push' &&
        (has('--force') ||
          rest.some(
            (a) =>
              /^-[a-z]*f[a-z]*$/.test(a) ||
              a.startsWith('--force-with-lease') ||
              a.startsWith('--mirror') ||
              a.startsWith('+')
          ))
      ) {
        return '`git push --force` rewrites remote history'
      }
      if (
        name === 'push' &&
        (has('--delete') ||
          rest.some((a) => /^-[a-z]*d[a-z]*$/.test(a) || /^:./.test(a)))
      ) {
        return '`git push --delete` removes a remote branch'
      }
      return null
    }
    case 'dd':
      return lower.some((a) => a.startsWith('of=/dev/'))
        ? '`dd` writes to a raw device'
        : null
    case 'format':
      return args[0] && isDrive(args[0]) ? '`format` erases a drive' : null
    default:
      if (cmd === 'mkfs' || cmd.startsWith('mkfs.')) {
        return '`mkfs` formats a filesystem'
      }
      return null
  }
}

function reasonAtDepth(
  command: string,
  workspace: Scope,
  depth: number
): string | null {
  if (depth > MAX_DEPTH) return 'nests shells too deeply to check'
  // A backslash is an escape in POSIX shells and a path separator on Windows,
  // and the command line does not say which. Read it both ways; either one
  // finding something is enough.
  const readings = command.includes('\\') ? [false, true] : [false]
  for (const posix of readings) {
    const reason = reasonForReading(command, workspace, depth, posix)
    if (reason) return reason
  }
  return null
}

function reasonForReading(
  command: string,
  workspace: Scope,
  depth: number,
  posixEscapes: boolean
): string | null {
  let parsed: Parsed
  try {
    parsed = parse(command, posixEscapes)
  } catch (error) {
    // The plain reading already parsed this, so a failure only here means a
    // Windows path ending in `\` inside quotes: not a reason to ask.
    if (posixEscapes) return null
    return `could not be parsed (${(error as Error).message}), so it cannot be checked`
  }
  for (const body of parsed.substitutions) {
    const reason = reasonAtDepth(body, workspace, depth + 1)
    if (reason) return reason
  }
  const scope = { ...workspace }
  for (const segment of parsed.segments) {
    const words = stripPrefixes(segment.words)
    if (!words.length) continue
    const reason = checkSegment(words, scope, depth, segment.piped)
    if (reason) return reason
    if (changesToUnknownDir(words, scope)) scope.cwdUnknown = true
  }
  const lowerCommand = command.toLowerCase()
  const phrase = RULES.sqlPhrases.find((p) => lowerCommand.includes(p))
  return phrase ? `runs \`${phrase.toUpperCase()}\`` : null
}

/**
 * Why `command` looks destructive (or cannot be checked), or null.
 * `workspace` is the approved scope: one root or several (a project and its
 * scratch folder, a chat's workspace). Deleting inside any of them is
 * ordinary work; with none, every absolute path counts as outside.
 */
export function destructiveCommandReason(
  command: string,
  workspace: string | DeletionScope
): string | null {
  return reasonAtDepth(
    command,
    {
      roots: typeof workspace === 'string' ? [workspace] : workspace,
      cwdUnknown: false,
    },
    0
  )
}
