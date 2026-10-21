/**
 * `enter_worktree` / `exit_worktree`: the agent moves this session's write
 * access into an isolated git worktree of the attached project, and back.
 *
 * Entering moves the session's write authority, so the user is asked every
 * time (`ALWAYS_ASK_TOOLS`), in every mode that offers the tool, and the prompt
 * names the folder, branch and base. The worktree is made (or an existing one
 * under the app's worktree folder is adopted) and granted exactly as a spawned
 * chat's or a campaign task's is: `useCoworkWorktrees.ensure`, then
 * `useDirectEditGrants.authorize`, then access `managed-worktree`. Where the
 * session's tools read and write is decided when a run starts, so the move
 * applies from the next message.
 *
 * Leaving never destroys work: with uncommitted or unmerged changes it refuses
 * to remove the worktree and tells the model to keep it or ask the user.
 */
import { jsonSchema, type Tool } from 'ai'
import type { ToolOutcome } from '@/lib/coworkRunner'
import { isReadOnly, type CoworkMode } from '@/lib/coworkMode'
import {
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
} from '@/lib/worktreeToolNames'
import { parseWorktreePr } from '@/lib/worktreePr'

export { ENTER_WORKTREE_TOOL_NAME, EXIT_WORKTREE_TOOL_NAME }

const MAX_NAME_CHARS = 60
const MAX_REF_CHARS = 100
/** A branch-like name: no leading dash, no spaces. */
const REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/

export const enterWorktreeTool: Tool = {
  description:
    "Move this session's write access into an isolated git worktree of its attached project, so changes land on their own branch and not in the user's checkout. " +
    'The user is asked to approve every call (it moves where you may write). The move applies from the next message in this session, not mid-turn. ' +
    '`name` names the branch (and finds an existing worktree of that name to switch to); `base` is the branch to start from; `pr` checks out a GitHub pull request (number or URL) by fetching its head from origin, and cannot be combined with `base`. ' +
    'Needs a project folder and a mode that allows changes.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'A short name for the worktree and its branch.',
      },
      base: {
        type: 'string',
        description:
          'The branch to start from. Default: the repository default branch (or the checked-out commit, if the user set that).',
      },
      pr: {
        type: ['string', 'integer'],
        description:
          'A GitHub pull request to work on: 123, #123 or its URL. Fetched from origin; fails at once if origin has no such pull request or needs a login.',
      },
    },
    additionalProperties: false,
  }),
} as Tool

export const exitWorktreeTool: Tool = {
  description:
    'Move this session back out of its worktree: write access to it is withdrawn and the session returns to review-only. ' +
    'Set `keep: true` to leave the worktree and its branch on disk. With `keep: false` the worktree is removed, but only when it holds no uncommitted and no unmerged work; otherwise the call is refused, and you should keep it or ask the user.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      keep: {
        type: 'boolean',
        description:
          'true: keep the worktree and branch. false: remove them if nothing would be lost.',
      },
    },
    required: ['keep'],
    additionalProperties: false,
  }),
} as Tool

/** What the dispatcher can offer: the caller's mode and its prompt. */
export type WorktreeToolContext = {
  mode?: CoworkMode
  toolCallId?: string
  signal?: AbortSignal
  onApprove?: (
    toolCallId: string,
    toolName: string,
    input: unknown,
    preview?: string,
    signal?: AbortSignal
  ) => Promise<boolean>
}

const refuse = (output: string): ToolOutcome => ({
  output: `ERROR: ${output}`,
  isError: true,
})

type Input = { name?: unknown; base?: unknown; pr?: unknown; keep?: unknown }
const asInput = (input: unknown): Input =>
  (input && typeof input === 'object' ? input : {}) as Input

// Imported when called: the stores pull in half the app, and this module is
// reached from the dispatcher.
async function stores() {
  const [
    { useCoworkSessions },
    { useCoworkWorktrees },
    { useDirectEditGrants },
    { getServiceHub },
  ] = await Promise.all([
    import('@/hooks/useCoworkSessions'),
    import('@/hooks/useCoworkWorktrees'),
    import('@/hooks/useDirectEditGrants'),
    import('@/hooks/useServiceHub'),
  ])
  return { useCoworkSessions, useCoworkWorktrees, useDirectEditGrants, getServiceHub }
}

export async function runEnterWorktree(
  sessionId: string,
  input: unknown,
  ctx: WorktreeToolContext = {}
): Promise<ToolOutcome> {
  const raw = asInput(input)
  if (raw.name !== undefined && typeof raw.name !== 'string')
    return refuse('`name` must be a string.')
  if (raw.base !== undefined && typeof raw.base !== 'string')
    return refuse('`base` must be a string.')
  let name = typeof raw.name === 'string' ? raw.name.trim() : ''
  let base = typeof raw.base === 'string' ? raw.base.trim() : ''
  let pr: number | undefined
  if (raw.pr !== undefined) {
    if (base) return refuse('use `pr` or `base`, not both.')
    const parsed = parseWorktreePr(raw.pr)
    if (!parsed.ok) return refuse(parsed.reason)
    pr = parsed.number
    base = parsed.base
    if (!name) name = `pr-${parsed.number}`
  }
  if (name.length > MAX_NAME_CHARS)
    return refuse(`\`name\` is over ${MAX_NAME_CHARS} characters. Shorten it.`)
  if (!pr && base && (base.length > MAX_REF_CHARS || !REF.test(base) || base.includes('..')))
    return refuse('`base` is not a valid branch name.')
  if (ctx.mode && isReadOnly(ctx.mode))
    return refuse(
      'a worktree gives this session write access, and this mode changes nothing.'
    )

  const s = await stores()
  const session = s.useCoworkSessions
    .getState()
    .sessions.find((x) => x.id === sessionId)
  if (!session) return refuse('this session no longer exists.')
  const project = session.folder ?? null
  if (!project)
    return refuse(
      'this session has no project folder attached. Ask the user to attach one.'
    )
  const held = s.useCoworkWorktrees.getState().bySession[sessionId]
  if (held && session.access === 'managed-worktree')
    return refuse(
      `this session is already in a worktree (${held.path}, branch ${held.branch || 'copy'}). Call exit_worktree first.`
    )
  if (!ctx.onApprove)
    return refuse(
      'entering a worktree needs the approval of the user of a Cowork session, and nothing here can ask for it.'
    )

  const dataFolder = (await s.getServiceHub().app().getJanDataFolder()) ?? ''
  if (!dataFolder) return refuse('the app data folder is not available.')
  const worktrees = s.useCoworkWorktrees.getState()

  // An existing worktree of that name, under the app's worktree folder, is
  // switched to; otherwise one is made.
  let record: Awaited<ReturnType<typeof worktrees.list>>[number] | undefined
  let created = false
  if (name) {
    const wanted = name.toLowerCase()
    const known = await worktrees.list(project, dataFolder)
    record = known.find((r) => {
      const b = (r.branch ?? '').toLowerCase()
      return b === wanted || b.endsWith(`/${wanted}`)
    })
  }
  if (record) {
    worktrees.adopt(sessionId, record)
  } else {
    const made = await worktrees.ensure(sessionId, project, dataFolder, {
      title: name || undefined,
      base: base || undefined,
    })
    if (!made.ok) return refuse(`could not create the worktree: ${made.reason}`)
    record = made.record
    created = true
  }
  const target = record
  const undo = async (reason: string): Promise<ToolOutcome> => {
    if (created)
      await s.useCoworkWorktrees
        .getState()
        .discard(sessionId, dataFolder, true)
        .catch(() => undefined)
    else s.useCoworkWorktrees.getState().forget(sessionId)
    return refuse(reason)
  }

  let allowed = false
  try {
    allowed = await ctx.onApprove(
      ctx.toolCallId ?? `enter-worktree-${sessionId}`,
      ENTER_WORKTREE_TOOL_NAME,
      {
        folder: target.path,
        branch: target.branch,
        base: target.baseBranch ?? (pr ? `pull request #${pr}` : base || 'the default branch'),
        project,
      },
      undefined,
      ctx.signal
    )
  } catch {
    allowed = false
  }
  if (!allowed || ctx.signal?.aborted)
    return undo(
      'the user did not allow entering a worktree. Do not retry it unchanged; carry on without one or wait for instructions.'
    )

  const granted = await s.useDirectEditGrants
    .getState()
    .authorize(sessionId, target.path, dataFolder, session.extraFolders ?? [])
  if (!granted.ok)
    return undo(`could not give the worktree write access: ${granted.reason}`)
  s.useCoworkSessions.getState().setAccess(sessionId, 'managed-worktree')

  return {
    output:
      `Entered worktree ${target.path} on branch ${target.branch || '(copy)'}` +
      `${target.baseBranch ? `, based on ${target.baseBranch}` : ''}. ` +
      'Write access to it is granted and the project folder itself is no longer written. ' +
      'This takes effect from the next message in this session; do not edit in this turn. ' +
      'Call exit_worktree to leave.',
  }
}

export async function runExitWorktree(
  sessionId: string,
  input: unknown,
  ctx: WorktreeToolContext = {}
): Promise<ToolOutcome> {
  const raw = asInput(input)
  if (typeof raw.keep !== 'boolean') return refuse('`keep` must be true or false.')
  const keep = raw.keep
  if (ctx.signal?.aborted) return refuse('cancelled.')

  const s = await stores()
  const worktrees = s.useCoworkWorktrees.getState()
  const record = worktrees.bySession[sessionId]
  if (!record) return refuse('this session is not in a worktree.')

  if (!keep) {
    const [pending, unmerged] = await Promise.all([
      worktrees.pending(record),
      worktrees.unmerged(record),
    ])
    if (pending.length > 0 || unmerged.length > 0) {
      const what = [
        pending.length ? `uncommitted changes (${pending.slice(0, 5).join(', ')})` : '',
        unmerged.length ? `${unmerged.length} unmerged commit(s)` : '',
      ]
        .filter(Boolean)
        .join(' and ')
      return refuse(
        `the worktree still holds ${what}, so it was not removed and this session did not leave it. ` +
          'Call exit_worktree with keep: true to leave it on disk, or ask the user what to do.'
      )
    }
    const dataFolder = (await s.getServiceHub().app().getJanDataFolder()) ?? ''
    const done = await worktrees.discard(sessionId, dataFolder, false)
    if (!done.ok)
      return refuse(
        `the worktree was not removed and the session did not leave it: ${done.reason}. Keep it or ask the user.`
      )
  } else {
    worktrees.forget(sessionId)
  }
  await s.useDirectEditGrants.getState().revokeSession(sessionId)
  s.useCoworkSessions.getState().setAccess(sessionId, 'review-only')

  return {
    output: keep
      ? `Left the worktree ${record.path} (branch ${record.branch || 'copy'}); it is kept on disk. This session is review-only again from the next message.`
      : `Left and removed the worktree ${record.path}. This session is review-only again from the next message.`,
  }
}
