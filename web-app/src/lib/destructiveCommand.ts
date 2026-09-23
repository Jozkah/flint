/**
 * Destructive shell command detection, run before `bash` executes.
 *
 * A match does not refuse the command: it forces the approval prompt even when
 * the session would otherwise run it unasked (auto mode, a standing grant), so
 * a person sees `rm -rf ~` before it runs rather than after. False positives
 * cost one click.
 *
 * Port of `src-tauri/src/core/agent/destructive.rs`; keep the two in step.
 */

const isDrive = (a: string) => /^[a-zA-Z]:$/.test(a)

/** Split into simple commands on `;`, `&&`, `||`, `|`, newlines; then words. */
function splitSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let cur = ''
  let quote: string | null = null
  const flush = () => {
    if (cur) {
      words.push(cur)
      cur = ''
    }
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === ' ' || c === '\t') flush()
    else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      flush()
      if ((c === '|' || c === '&') && command[i + 1] === c) i++
      if (words.length) {
        segments.push(words)
        words = []
      }
    } else cur += c
  }
  flush()
  if (words.length) segments.push(words)
  return segments
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time'])

function stripPrefixes(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]
    const assignment = w.includes('=') && !w.startsWith('-') && !w.startsWith('=')
    if (WRAPPERS.has(w) || assignment) {
      i++
      continue
    }
    if (w.startsWith('-') && i > 0 && words[i - 1] === 'sudo') {
      i++
      continue
    }
    break
  }
  return words.slice(i)
}

/**
 * A deletion target that reaches beyond the project: the filesystem root,
 * home, a parent directory, an unresolved variable, or an absolute path not
 * under `workspace`. An empty `workspace` makes every absolute path outside.
 */
export function outsideWorkspace(target: string, workspace: string): boolean {
  const t = target.replace(/^["']|["']$/g, '')
  if (!t) return false
  if (t.startsWith('~') || t.startsWith('$') || t.startsWith('%')) return true
  const norm = t.replace(/\\/g, '/')
  if (
    norm === '..' ||
    norm.startsWith('../') ||
    norm.includes('/../') ||
    norm.endsWith('/..')
  ) {
    return true
  }
  const absolute = norm.startsWith('/') || isDrive(norm.slice(0, 2))
  if (!absolute) return false
  const root = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root) return true
  const ci = isDrive(norm.slice(0, 2)) || isDrive(root.slice(0, 2))
  const n = (ci ? norm.toLowerCase() : norm).replace(/[/*]+$/, '')
  const r = ci ? root.toLowerCase() : root
  return !(n === r || n.startsWith(`${r}/`))
}

function checkSegment(words: string[], workspace: string): string | null {
  const first = words[0].toLowerCase()
  const cmd = first.split(/[/\\]/).pop() ?? first
  const args = words.slice(1)
  const lower = args.map((a) => a.toLowerCase())
  const has = (f: string) => lower.includes(f)

  switch (cmd) {
    case 'rm': {
      let recursive = false
      let force = false
      const targets: string[] = []
      for (const a of args) {
        if (a === '--recursive') recursive = true
        else if (a === '--force') force = true
        else if (a.startsWith('--')) continue
        else if (a.startsWith('-')) {
          recursive ||= /[rR]/.test(a)
          force ||= a.includes('f')
        } else targets.push(a)
      }
      if (recursive && force) {
        const t = targets.find((x) => outsideWorkspace(x, workspace))
        if (t) return `\`rm -rf\` on \`${t}\`, outside the workspace`
      }
      return null
    }
    case 'git': {
      const sub = lower.find((a) => !a.startsWith('-'))
      if (sub === 'reset' && has('--hard')) {
        return '`git reset --hard` discards uncommitted work'
      }
      if (sub === 'clean') {
        const short = lower
          .filter((a) => a.startsWith('-') && !a.startsWith('--'))
          .map((a) => a.replace(/^-+/, ''))
          .join('')
        const force = short.includes('f') || has('--force')
        if (force && (short.includes('d') || short.includes('x'))) {
          return '`git clean` deletes untracked files'
        }
      }
      if (
        sub === 'push' &&
        (has('--force') ||
          has('-f') ||
          lower.some(
            (a) => a.startsWith('--force-with-lease') || a.startsWith('--mirror')
          ))
      ) {
        return '`git push --force` rewrites remote history'
      }
      return null
    }
    case 'dropdb':
      return 'drops a database'
    case 'dd':
      return lower.some((a) => a.startsWith('of=/dev/'))
        ? '`dd` writes to a raw device'
        : null
    case 'remove-item':
    case 'ri': {
      const recurse = lower.some((a) => a.startsWith('-r'))
      const force = has('-force')
      if (recurse && force) {
        const target = args.find((a) => !a.startsWith('-')) ?? '.'
        if (outsideWorkspace(target, workspace)) {
          return `\`Remove-Item -Recurse -Force\` on \`${target}\`, outside the workspace`
        }
      }
      return null
    }
    case 'del':
    case 'erase':
      return has('/s') ? '`del /s` deletes recursively' : null
    case 'rd':
    case 'rmdir': {
      if (!has('/s')) return null
      const target = args.find((a) => !a.startsWith('/')) ?? '.'
      return outsideWorkspace(target, workspace)
        ? `\`${cmd} /s\` on \`${target}\`, outside the workspace`
        : null
    }
    case 'format':
      return args[0] && isDrive(args[0]) ? '`format` erases a drive' : null
    default:
      if (cmd === 'mkfs' || cmd.startsWith('mkfs.')) {
        return '`mkfs` formats a filesystem'
      }
      return null
  }
}

/** Why `command` looks destructive, or null. */
export function destructiveCommandReason(
  command: string,
  workspace: string
): string | null {
  for (const segment of splitSegments(command)) {
    const words = stripPrefixes(segment)
    if (!words.length) continue
    const reason = checkSegment(words, workspace)
    if (reason) return reason
  }
  const lower = command.toLowerCase()
  if (lower.includes('drop database') || lower.includes('drop schema')) {
    return 'drops a database'
  }
  return null
}
