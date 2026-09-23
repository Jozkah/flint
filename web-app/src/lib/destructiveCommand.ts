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
  inlineShells: string[]
  powershells: string[]
  uncertainCommands: Record<string, string>
  alwaysAskCommands: Record<string, string>
  deleteCommands: string[]
  sqlPhrases: string[]
}

const RULES = rules as unknown as Rules

/** How deep `bash -c`, `cmd /c` and `$(...)` may nest before we give up. */
const MAX_DEPTH = 4

const isDrive = (a: string) => /^[a-zA-Z]:$/.test(a)

type Parsed = { segments: string[][]; substitutions: string[] }

/**
 * Split into simple commands on `;`, `&`, `&&`, `||`, `|`, newlines (POSIX
 * shells, PowerShell, cmd.exe), then words; collect `$(...)`, `` `...` `` and
 * `<(...)` bodies. Throws on an unclosed quote or substitution.
 */
function parse(command: string): Parsed {
  const out: Parsed = { segments: [], substitutions: [] }
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
      if ((c === '|' || c === '&') && command[i + 1] === c) i++
      if (words.length) {
        out.segments.push(words)
        words = []
      }
    } else cur += c
    i++
  }
  if (quote) throw new Error('unbalanced quote')
  flush()
  if (words.length) out.segments.push(words)
  return out
}

function stripPrefixes(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]
    const assignment =
      w.includes('=') && !w.startsWith('-') && !w.startsWith('=')
    if (RULES.wrappers.includes(w) || assignment) {
      i++
      continue
    }
    if (w.startsWith('-') && i > 0 && RULES.wrappers.includes(words[i - 1])) {
      i++
      continue
    }
    break
  }
  return words.slice(i)
}

/** The command name a word invokes: no directory, no `.exe`, lowercase. */
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
  workspace: string | DeletionScope
): boolean {
  const t = target.replace(/^["']+|["']+$/g, '')
  if (!t) return false
  if (/^[~$%`]/.test(t)) return true
  const norm = t.replace(/\\/g, '/')
  // `C:foo` is relative to that drive's current directory, which is unknown.
  if (isDrive(norm.slice(0, 2)) && !isAbsolutePath(norm)) return true
  if (!isAbsolutePath(norm)) {
    return (
      norm === '..' ||
      norm.startsWith('../') ||
      norm.includes('/../') ||
      norm.endsWith('/..')
    )
  }
  const n = comparablePath(norm.replace(/[/*]+$/, '') || '/')
  if (n === null) return true
  const ci = isDrive(n.slice(0, 2))
  const roots = scopeRoots(typeof workspace === 'string' ? [workspace] : workspace)
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

function firstOutside(
  targets: string[],
  workspace: DeletionScope
): string | undefined {
  return (targets.length ? targets : ['.']).find((t) =>
    outsideWorkspace(t, workspace)
  )
}

function checkSegment(
  words: string[],
  workspace: DeletionScope,
  depth: number
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
  if (RULES.inlineShells.includes(cmd)) {
    const at = lower.findIndex(
      (a) => a.startsWith('-') && !a.startsWith('--') && a.includes('c')
    )
    if (at === -1 || args[at + 1] === undefined) return null
    return reasonAtDepth(args[at + 1], workspace, depth + 1)
  }
  if (cmd === 'cmd') {
    const at = lower.findIndex((a) => a === '/c' || a === '/k')
    if (at === -1) return null
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
    if (at === -1) return null
    return reasonAtDepth(args.slice(at + 1).join(' '), workspace, depth + 1)
  }

  switch (cmd) {
    case 'rm':
    case 'unlink':
    case 'shred':
    case 'remove-item':
    case 'ri': {
      const { recursive, targets } = deletionFlags(args, false)
      if (!(recursive || cmd === 'shred')) return null
      const t = targets.find((x) => outsideWorkspace(x, workspace))
      return t ? outsideReason(words, t, 'deletes') : null
    }
    case 'del':
    case 'erase': {
      if (lower.includes('/s')) return '`del /s` deletes recursively'
      const { recursive, targets } = deletionFlags(args, true)
      if (!recursive) return null
      const t = targets.find((x) => outsideWorkspace(x, workspace))
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
      for (const a of args) {
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
        const force = short.includes('f') || has('--force')
        if (force && (short.includes('d') || short.includes('x'))) {
          return '`git clean` deletes untracked files'
        }
      }
      if (
        name === 'push' &&
        (has('--force') ||
          has('-f') ||
          rest.some(
            (a) =>
              a.startsWith('--force-with-lease') ||
              a.startsWith('--mirror') ||
              a.startsWith('+')
          ))
      ) {
        return '`git push --force` rewrites remote history'
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
  workspace: DeletionScope,
  depth: number
): string | null {
  if (depth > MAX_DEPTH) return 'nests shells too deeply to check'
  let parsed: Parsed
  try {
    parsed = parse(command)
  } catch (error) {
    return `could not be parsed (${(error as Error).message}), so it cannot be checked`
  }
  for (const body of parsed.substitutions) {
    const reason = reasonAtDepth(body, workspace, depth + 1)
    if (reason) return reason
  }
  for (const segment of parsed.segments) {
    const words = stripPrefixes(segment)
    if (!words.length) continue
    const reason = checkSegment(words, workspace, depth)
    if (reason) return reason
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
    typeof workspace === 'string' ? [workspace] : workspace,
    0
  )
}
