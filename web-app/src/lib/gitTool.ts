/**
 * The `git` agent tool, as the renderer sees it: which calls are put to the
 * user, and what the prompt says about them.
 *
 * The tool itself runs in Rust (`tools/git_tool.rs`), which refuses a call
 * this module would refuse and runs the rest. This mirror decides only when to
 * ask: reads run straight away, local changes ask like a file change, and
 * anything that writes to a remote or can lose work is asked about every time,
 * naming the command, remote and branch. Both sides are tested against one
 * table (`__tests__/gitToolCases.json`) so they cannot drift apart.
 */
import { isPlainObject, parseToolInput } from '@/lib/toolInputSummary'

export const GIT_TOOL_NAME = 'git'

export type GitClass = 'read' | 'local' | 'remote'

export type GitPlan = {
  program: 'git' | 'gh'
  args: string[]
  class: GitClass
  /** Why the call can lose work or rewrite shared history, if it can. */
  destructive?: string
  /** Talks to a remote at all (clone, fetch, push, gh). */
  reachesRemote: boolean
  /** The remote or gh `--repo` the call names. */
  remote?: string
  /** The branch or refspec the call names. */
  branch?: string
  cwd?: string
}

export type GitPlanResult =
  | { ok: true; plan: GitPlan }
  | { ok: false; error: string }

const has = (args: string[], flags: string[]) =>
  args.some((a) => flags.includes(a))

const hasOpt = (args: string[], flags: string[]) =>
  args.some((a) =>
    flags.some((f) => a === f || (f.startsWith('--') && a.startsWith(`${f}=`)))
  )

const hasShort = (args: string[], c: string) =>
  args.some(
    (a) =>
      a.startsWith('-') &&
      !a.startsWith('--') &&
      a.length > 1 &&
      a.slice(1).includes(c)
  )

function positionals(args: string[], valueFlags: string[] = []): string[] {
  const out: string[] = []
  let afterDashDash = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (afterDashDash) out.push(a)
    else if (a === '--') afterDashDash = true
    else if (a.startsWith('-') && a.length > 1) {
      if (valueFlags.includes(a)) i++
    } else out.push(a)
  }
  return out
}

const DENIED_GIT_OPTIONS = [
  '--upload-pack',
  '--receive-pack',
  '--exec',
  '--template',
  '--config',
  '--config-env',
  '--no-index',
  '--output',
  '--output-directory',
  '--open-files-in-pager',
  '--git-dir',
  '--work-tree',
  '--separate-git-dir',
  '--reference',
  '--reference-if-able',
  '--ext-diff',
]

function denyCommonGit(sub: string, rest: string[]): string | null {
  for (const a of rest) {
    const lower = a.toLowerCase()
    for (const opt of DENIED_GIT_OPTIONS) {
      if (lower === opt || lower.startsWith(`${opt}=`)) {
        return `the option \`${a}\` is not allowed`
      }
    }
    if (lower.startsWith('ext::') || lower.startsWith('fd::')) {
      return `the transport in \`${a}\` is not allowed`
    }
  }
  if ((sub === 'clone' || sub === 'ls-remote') && has(rest, ['-u'])) {
    return '`-u` (upload-pack) is not allowed'
  }
  if (sub === 'clone' && has(rest, ['-c'])) return '`clone -c` is not allowed'
  if (sub === 'rebase' && rest.some((a) => a.startsWith('-x'))) {
    return '`rebase -x` is not allowed'
  }
  if (sub === 'grep' && rest.some((a) => a.startsWith('-O'))) {
    return '`grep -O` is not allowed'
  }
  if (sub === 'merge' || sub === 'pull') {
    const ok = ['ort', 'recursive', 'resolve', 'octopus', 'ours', 'subtree']
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]
      const v =
        a === '-s' || a === '--strategy'
          ? rest[i + 1]
          : a.startsWith('--strategy=')
            ? a.slice('--strategy='.length)
            : undefined
      if (v !== undefined && !ok.includes(v))
        return `merge strategy \`${v}\` is not allowed`
    }
  }
  return null
}

function cloneUrlOk(url: string): boolean {
  const l = url.toLowerCase()
  return (
    l.startsWith('https://') ||
    l.startsWith('ssh://') ||
    (l.startsWith('git@') && l.includes(':'))
  )
}

const CLONE_VALUES = [
  '-b',
  '--branch',
  '--depth',
  '-o',
  '--origin',
  '-j',
  '--jobs',
  '--filter',
  '--shallow-since',
  '--shallow-exclude',
  '--bundle-uri',
]

function gitPlan(input: string[]): GitPlanResult {
  const args = [...input]
  while (args[0] === '--no-pager') args.shift()
  const sub = args[0]
  if (!sub) return { ok: false, error: 'no git subcommand given' }
  if (sub.startsWith('-')) {
    return {
      ok: false,
      error: `global options before the subcommand (\`${sub}\`) are not allowed`,
    }
  }
  const rest = args.slice(1)
  const denied = denyCommonGit(sub, rest)
  if (denied) return { ok: false, error: denied }
  const plan: GitPlan = {
    program: 'git',
    args,
    class: 'local',
    reachesRemote: false,
  }
  const first = rest[0]
  const fail = (error: string): GitPlanResult => ({ ok: false, error })
  switch (sub) {
    case 'status':
    case 'log':
    case 'diff':
    case 'show':
    case 'rev-parse':
    case 'ls-files':
    case 'ls-tree':
    case 'blame':
    case 'shortlog':
    case 'describe':
    case 'cat-file':
    case 'grep':
    case 'rev-list':
    case 'merge-base':
    case 'name-rev':
    case 'show-ref':
    case 'for-each-ref':
    case 'whatchanged':
    case 'count-objects':
    case 'check-ignore':
    case 'version':
    case 'diff-tree':
    case 'diff-index':
    case 'diff-files':
    case 'range-diff':
      plan.class = 'read'
      break
    case 'ls-remote':
      plan.class = 'read'
      plan.reachesRemote = true
      plan.remote = positionals(rest)[0]
      break
    case 'branch': {
      const deleting = hasOpt(rest, ['-d', '--delete', '-D'])
      const forced =
        has(rest, ['-D', '-M', '-C']) ||
        (deleting && hasOpt(rest, ['-f', '--force']))
      const changes =
        deleting ||
        hasOpt(rest, [
          '-m',
          '-M',
          '--move',
          '-c',
          '-C',
          '--copy',
          '-u',
          '--set-upstream-to',
          '--unset-upstream',
          '--edit-description',
          '-f',
          '--force',
          '-t',
          '--track',
        ])
      const listing = hasOpt(rest, [
        '-l',
        '--list',
        '-a',
        '--all',
        '-r',
        '--remotes',
        '--show-current',
        '--contains',
        '--no-contains',
        '--merged',
        '--no-merged',
        '--points-at',
      ])
      const values = [
        '--contains',
        '--no-contains',
        '--merged',
        '--no-merged',
        '--points-at',
        '--format',
        '--sort',
        '--color',
        '--column',
      ]
      if (changes) plan.class = 'local'
      else if (listing || positionals(rest, values).length === 0)
        plan.class = 'read'
      if (forced)
        plan.destructive =
          'deletes or overwrites a branch even if its commits are not merged'
      plan.branch = positionals(rest, values)[0]
      break
    }
    case 'tag': {
      const listing = hasOpt(rest, [
        '-l',
        '--list',
        '--contains',
        '--points-at',
        '--merged',
        '--no-merged',
        '-n',
        '-v',
        '--verify',
      ])
      const values = [
        '--contains',
        '--points-at',
        '--merged',
        '--no-merged',
        '-m',
        '--message',
        '-F',
        '--file',
        '--sort',
        '--format',
      ]
      if (
        !hasOpt(rest, [
          '-d',
          '--delete',
          '-a',
          '-s',
          '-f',
          '--force',
          '-m',
          '--message',
        ]) &&
        (listing || positionals(rest, values).length === 0)
      ) {
        plan.class = 'read'
      }
      if (hasOpt(rest, ['-f', '--force']))
        plan.destructive = 'moves an existing tag'
      break
    }
    case 'remote':
      if (
        first === undefined ||
        ['-v', '--verbose', 'show', 'get-url'].includes(first)
      ) {
        plan.class = 'read'
        if (first === 'show') plan.reachesRemote = true
      } else if (
        [
          'add',
          'rename',
          'remove',
          'rm',
          'set-url',
          'set-head',
          'set-branches',
          'prune',
          'update',
        ].includes(first)
      ) {
        const url = positionals(rest.slice(1), ['-t', '-m'])[1]
        if (
          url &&
          (first === 'add' || first === 'set-url') &&
          !cloneUrlOk(url)
        ) {
          return fail(
            `only https://, ssh:// and git@host: URLs are allowed, not \`${url}\``
          )
        }
      } else return fail(`\`git remote ${first}\` is not supported`)
      break
    case 'stash':
      if (first === 'list' || first === 'show') plan.class = 'read'
      else if (first === 'drop' || first === 'clear')
        plan.destructive = 'discards stashed changes'
      break
    case 'config': {
      if (
        hasOpt(rest, [
          '--global',
          '--system',
          '--file',
          '-f',
          '--blob',
          '--worktree',
          '--includes',
        ])
      ) {
        return fail('`git config --global/--system/--file` is not allowed')
      }
      const reading =
        hasOpt(rest, [
          '--get',
          '--get-all',
          '--get-regexp',
          '--get-urlmatch',
          '--list',
          '-l',
          '--get-color',
          '--get-colorbool',
        ]) ||
        first === 'get' ||
        first === 'list' ||
        (rest.length === 1 && !rest[0].startsWith('-'))
      if (!reading)
        return fail(
          'changing Git configuration is not allowed through this tool'
        )
      plan.class = 'read'
      break
    }
    case 'worktree':
      if (first === 'list') plan.class = 'read'
      else if (first === 'remove' && hasOpt(rest, ['-f', '--force'])) {
        plan.destructive = 'removes a worktree with uncommitted changes'
      } else if (
        ![
          'add',
          'remove',
          'move',
          'prune',
          'lock',
          'unlock',
          'repair',
        ].includes(first ?? '')
      ) {
        return fail(
          '`git worktree` supports list, add, remove, move, prune, lock, unlock, repair'
        )
      }
      break
    case 'reflog':
      if (first === 'expire' || first === 'delete' || first === 'drop') {
        plan.destructive =
          'deletes reflog entries, the record that recovers lost commits'
      } else plan.class = 'read'
      break
    case 'reset':
      if (hasOpt(rest, ['--hard', '--merge', '--keep'])) {
        plan.destructive = 'discards uncommitted changes in the working tree'
      }
      break
    case 'clean':
      if (hasOpt(rest, ['-n', '--dry-run']) || hasShort(rest, 'n'))
        plan.class = 'read'
      else plan.destructive = 'permanently deletes untracked files'
      break
    case 'checkout':
      if (hasOpt(rest, ['-f', '--force']) || has(rest, ['--', '.'])) {
        plan.destructive = 'overwrites uncommitted changes in the working tree'
      }
      plan.branch = positionals(rest, ['-b', '-B', '--orphan'])[0]
      if (has(rest, ['-B'])) plan.destructive = 'resets an existing branch'
      break
    case 'switch':
      if (hasOpt(rest, ['-f', '--force', '--discard-changes']))
        plan.destructive = 'discards uncommitted changes'
      if (has(rest, ['-C', '--force-create']))
        plan.destructive = 'resets an existing branch'
      plan.branch = positionals(rest, [
        '-c',
        '--create',
        '-C',
        '--force-create',
        '--orphan',
      ])[0]
      break
    case 'restore': {
      const stagedOnly =
        hasOpt(rest, ['-S', '--staged']) && !hasOpt(rest, ['-W', '--worktree'])
      if (!stagedOnly)
        plan.destructive = 'discards uncommitted changes in the working tree'
      break
    }
    case 'rm':
      if (hasOpt(rest, ['-f', '--force']))
        plan.destructive = 'removes files with uncommitted changes'
      break
    case 'add':
    case 'commit':
    case 'mv':
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
    case 'revert':
    case 'am':
    case 'apply':
    case 'init':
    case 'notes':
    case 'sparse-checkout':
    case 'update-index':
      break
    case 'clone': {
      plan.reachesRemote = true
      const url = positionals(rest, CLONE_VALUES)[0]
      if (!url) return fail('git clone needs a repository URL')
      if (!cloneUrlOk(url))
        return fail(
          `only https://, ssh:// and git@host: URLs can be cloned, not \`${url}\``
        )
      plan.remote = url
      break
    }
    case 'fetch':
    case 'pull': {
      plan.reachesRemote = true
      const pos = positionals(rest, [
        '--depth',
        '-j',
        '--jobs',
        '-s',
        '--strategy',
        '-X',
        '--strategy-option',
      ])
      plan.remote = pos[0]
      plan.branch = pos[1]
      break
    }
    case 'push': {
      plan.class = 'remote'
      plan.reachesRemote = true
      const pos = positionals(rest, [
        '-o',
        '--push-option',
        '--repo',
        '--receive-pack',
        '--exec',
      ])
      plan.remote = pos[0]
      const refs = pos.slice(1)
      if (refs.length) plan.branch = refs.join(' ')
      const force =
        hasOpt(rest, [
          '-f',
          '--force',
          '--force-with-lease',
          '--force-if-includes',
          '--mirror',
        ]) || refs.some((r) => r.startsWith('+'))
      const deletes =
        hasOpt(rest, ['-d', '--delete', '--prune']) ||
        refs.some((r) => r.startsWith(':'))
      if (force)
        plan.destructive =
          'force push: rewrites history on the remote that others may have'
      else if (deletes)
        plan.destructive = 'deletes branches or tags on the remote'
      break
    }
    default:
      return fail(`\`git ${sub}\` is not supported by this tool`)
  }
  return { ok: true, plan }
}

const GH_READ: Record<string, string[] | '*'> = {
  repo: ['view', 'list'],
  pr: ['list', 'view', 'status', 'diff', 'checks'],
  issue: ['list', 'view', 'status'],
  run: ['list', 'view'],
  release: ['list', 'view'],
  workflow: ['list', 'view'],
  auth: ['status'],
  search: '*',
  status: '*',
  label: ['list'],
}
const GH_LOCAL: Record<string, string[]> = { repo: ['clone'], pr: ['checkout'] }
const GH_REMOTE: Record<string, string[]> = {
  repo: ['create', 'fork', 'edit', 'sync'],
  pr: [
    'create',
    'merge',
    'comment',
    'reopen',
    'edit',
    'review',
    'ready',
    'lock',
    'unlock',
    'close',
  ],
  issue: [
    'create',
    'comment',
    'close',
    'reopen',
    'edit',
    'lock',
    'unlock',
    'pin',
    'unpin',
    'develop',
  ],
  release: ['create', 'edit', 'upload'],
  label: ['create', 'edit'],
  run: ['rerun', 'cancel'],
}
const GH_DESTRUCTIVE: Record<string, [string[], string]> = {
  repo: [
    ['delete', 'archive', 'rename', 'unarchive'],
    "deletes or changes a GitHub repository's name or availability",
  ],
  issue: [
    ['delete', 'transfer'],
    'permanently deletes or moves content on GitHub',
  ],
  release: [
    ['delete', 'delete-asset'],
    'permanently deletes content on GitHub',
  ],
  label: [['delete'], 'permanently deletes content on GitHub'],
}

/** How gh calls are written, for refusals that should teach the shape. */
const GH_SHAPES =
  'Write gh calls subcommand first, flags with their dashes, each flag and value as separate entries, e.g. ["pr", "create", "--repo", "owner/repo", "--head", "my-branch", "--base", "main", "--title", "T", "--body", "B"] or ["issue", "list", "--repo", "owner/repo", "--json", "number,title"].'

/**
 * `gh -R owner/repo issue list` is a spelling gh itself accepts: the leading
 * `-R/--repo` moves behind the subcommand, as tools/git_tool.rs does, so the
 * prompt decision here and the backend's classification agree.
 */
function moveLeadingRepo(
  args: string[]
): { ok: true; args: string[] } | { ok: false; error: string } {
  const lead: string[] = []
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === '-R' || a === '--repo') {
      if (args[i + 1] === undefined)
        return {
          ok: false,
          error: `\`${a}\` needs a repository after it. ${GH_SHAPES}`,
        }
      lead.push(a, args[i + 1])
      i += 2
    } else if (a.startsWith('--repo=')) {
      lead.push(a)
      i += 1
    } else break
  }
  if (!lead.length) return { ok: true, args }
  const rest = args.slice(i)
  if (!rest.length)
    return {
      ok: false,
      error: `no gh command given after \`${lead.join(' ')}\`. ${GH_SHAPES}`,
    }
  const at = rest[1] !== undefined && !rest[1].startsWith('-') ? 2 : 1
  return { ok: true, args: [...rest.slice(0, at), ...lead, ...rest.slice(at)] }
}

const GH_CREATE_VALUE_FLAGS = [
  '-R', '--repo', '-t', '--title', '-b', '--body', '-F', '--body-file',
  '-B', '--base', '-H', '--head', '-l', '--label', '-a', '--assignee',
  '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-T',
  '--template', '--recover',
]

/** Mistakes a model makes in gh's argument shape, named with the fix. */
function ghShapeError(
  group: string,
  action: string,
  args: string[]
): string | null {
  if (has(args, ['--web', '-w']))
    return `\`--web\` opens a browser you cannot see and returns nothing; drop it (use \`--json <fields>\` to read). ${GH_SHAPES}`
  const j = args.indexOf('--json')
  if (j >= 0) {
    const words: string[] = []
    for (const a of args.slice(j + 1)) {
      if (a.startsWith('-')) break
      words.push(a)
    }
    if (words.length >= 3 && words.every((w) => /^[A-Za-z0-9]+$/.test(w)))
      return `\`--json\` takes ONE comma-separated value: ["--json", "${words.join(',')}"], not separate arguments. ${GH_SHAPES}`
    if (!words.length)
      return `\`--json\` needs the fields to return, e.g. ["--json", "number,title"]. ${GH_SHAPES}`
  }
  if ((group === 'pr' || group === 'issue') && action === 'create') {
    const stray = positionals(args.slice(2), GH_CREATE_VALUE_FLAGS)
    if (stray.length)
      return `\`gh ${group} create\` takes no positional arguments, but got \`${stray[0]}\` -- were the dashes dropped (\`--title\`, \`--body\`, \`--repo\`)? ${GH_SHAPES}`
  }
  return null
}

function ghPlan(input: string[]): GitPlanResult {
  const moved = moveLeadingRepo(input)
  if (!moved.ok) return moved
  const args = moved.args
  const group = args[0]
  if (!group) return { ok: false, error: `no gh command given. ${GH_SHAPES}` }
  if (group.startsWith('-'))
    return {
      ok: false,
      error: `options before the gh command (\`${group}\`) are not allowed: put the subcommand first. ${GH_SHAPES}`,
    }
  if (group === 'auth' && hasOpt(args, ['--show-token', '-t'])) {
    return { ok: false, error: '`gh auth status --show-token` is not allowed' }
  }
  const action = args[1] ?? ''
  const shape = ghShapeError(group, action, args)
  if (shape) return { ok: false, error: shape }
  const plan: GitPlan = {
    program: 'gh',
    args,
    class: 'read',
    reachesRemote: true,
  }
  const read = GH_READ[group]
  const destructive = GH_DESTRUCTIVE[group]
  if (read === '*' || read?.includes(action)) plan.class = 'read'
  else if (GH_LOCAL[group]?.includes(action)) plan.class = 'local'
  else if (GH_REMOTE[group]?.includes(action)) {
    plan.class = 'remote'
    if (
      group === 'pr' &&
      action === 'close' &&
      hasOpt(args, ['-d', '--delete-branch'])
    ) {
      plan.destructive = 'closes the pull request and deletes its branch'
    }
  } else if (destructive?.[0].includes(action)) {
    plan.class = 'remote'
    plan.destructive = destructive[1]
  } else {
    return {
      ok: false,
      error: `\`gh ${group} ${action}\` is not supported by this tool. ${GH_SHAPES}`,
    }
  }
  if (group === 'pr' && action === 'merge' && hasOpt(args, ['--admin'])) {
    plan.destructive =
      'merges with administrator privileges, bypassing branch protection'
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-R' || args[i] === '--repo') plan.remote = args[i + 1]
    else if (args[i].startsWith('--repo='))
      plan.remote = args[i].slice('--repo='.length)
  }
  if (group === 'repo' && !plan.remote && args[2] && !args[2].startsWith('-'))
    plan.remote = args[2]
  const branchParts: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (['-B', '--base', '-H', '--head'].includes(args[i]))
      branchParts.push(`${args[i]} ${args[i + 1] ?? ''}`)
  }
  if (branchParts.length) plan.branch = branchParts.join(' ')
  return { ok: true, plan }
}

/** Classify a call to `program` with `args` (argv after the program). */
export function planGitCall(program: string, input: string[]): GitPlanResult {
  const args = [...input]
  if (args[0] === program) args.shift()
  if (args.some((a) => a.includes('\0')))
    return { ok: false, error: 'NUL in arguments' }
  if (program === 'git') return gitPlan(args)
  if (program === 'gh') return ghPlan(args)
  return { ok: false, error: `program must be git or gh, not ${program}` }
}

/** Classify a `git` tool call's input (`{program?, args, cwd?}`). */
export function planGitTool(input: unknown): GitPlanResult {
  const parsed = parseToolInput(input)
  const obj = isPlainObject(parsed) ? parsed : {}
  const program =
    typeof obj.program === 'string' && obj.program.trim()
      ? obj.program.trim()
      : 'git'
  if (!Array.isArray(obj.args) || obj.args.some((a) => typeof a !== 'string')) {
    return { ok: false, error: '`args` must be an array of strings' }
  }
  const result = planGitCall(program, obj.args as string[])
  if (result.ok && typeof obj.cwd === 'string' && obj.cwd.trim()) {
    result.plan.cwd = obj.cwd.trim()
  }
  return result
}

/** The command line as shown to the user. */
export function gitCommandLine(
  plan: Pick<GitPlan, 'program' | 'args'>
): string {
  return [
    plan.program,
    ...plan.args.map((a) =>
      a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
    ),
  ].join(' ')
}

/** Asked about every time: writes to a remote, or can lose work. */
export const gitAlwaysAsks = (plan: GitPlan): boolean =>
  plan.class === 'remote' || plan.destructive !== undefined

/**
 * How a `git` call is gated in the renderer: `null` when it runs without a
 * prompt (a read, or a call the backend will refuse anyway), otherwise
 * whether it must be asked about every time and why.
 */
export function gitApproval(
  input: unknown
): null | { plan: GitPlan; alwaysAsk: boolean; reason?: string } {
  const result = planGitTool(input)
  if (!result.ok || result.plan.class === 'read') return null
  const { plan } = result
  if (!gitAlwaysAsks(plan)) return { plan, alwaysAsk: false }
  const pushes = plan.program === 'git' && plan.args[0] === 'push'
  const reason = plan.destructive
    ? `Destructive: ${plan.destructive}. Asked every time.`
    : pushes
      ? `Push: publishes commits to ${plan.remote ?? 'the default remote'}, where others can see them. Asked every time.`
      : `Reaches ${plan.program === 'gh' ? 'GitHub' : 'the remote'}: asked every time.`
  return { plan, alwaysAsk: true, reason }
}

/**
 * Whether a git call runs inside the session's own tree: its managed worktree
 * when it has one, else its sandbox workspace. `cwd` is the call's argument;
 * a relative one resolves against the worktree (the backend's default folder
 * when a folder is granted). With no worktree, a session that was granted a
 * real project folder is working in the user's folder, not its own.
 */
export function gitInsideSessionTree(
  cwd: string | undefined,
  worktreePath: string | null | undefined,
  hasWriteGrant: boolean
): boolean {
  const norm = (p: string) =>
    p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const escapes = (p: string) => p.split(/[\\/]/).includes('..')
  if (worktreePath) {
    if (!cwd) return true
    if (escapes(cwd)) return false
    const absolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(cwd)
    if (!absolute) return true
    const root = norm(worktreePath)
    const target = norm(cwd)
    return target === root || target.startsWith(`${root}/`)
  }
  return !hasWriteGrant
}

/**
 * The facts a remote-writing prompt names that the call itself may leave
 * implicit: the current branch and the remote's URL, read with read-only git
 * calls (which never prompt). `run` executes one `git` tool call and returns
 * its text, or null on failure. Best effort: a fact that cannot be read is
 * left out rather than guessed.
 */
export async function gitRemoteFacts(
  plan: GitPlan,
  run: (args: string[]) => Promise<string | null>
): Promise<string | undefined> {
  if (plan.class !== 'remote' || plan.program !== 'git') return undefined
  const strip = (out: string | null) =>
    out
      ?.split(/\r?\n/)
      .filter((l) => !l.startsWith('$ '))
      .join(' ')
      .trim() || undefined
  const branch =
    plan.branch ?? strip(await run(['rev-parse', '--abbrev-ref', 'HEAD']))
  const remote = plan.remote ?? 'origin'
  const url = strip(await run(['remote', 'get-url', remote]))
  const parts = [`Remote ${remote}${url ? ` (${url})` : ''}`]
  if (branch) parts.push(`branch ${branch}`)
  return `${parts.join(', ')}.`
}
