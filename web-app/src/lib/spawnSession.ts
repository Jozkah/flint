/**
 * `spawn_session`: the agent starts a nested chat.
 *
 * Not a subagent. A subagent (`task`) lives inside the parent's run and hands
 * back one answer; a nested chat is a real Cowork session -- its own
 * transcript in the sidebar, nested under this one, that the user can open,
 * talk to and stop. It starts on the prompt it is given and the parent does
 * not wait for it.
 *
 * The child starts unbound, like a fork (hooks/useCoworkSessions `forkSession`):
 * no folder, no grants, the default mode. Spawning must not multiply the
 * authority the user gave this session. It is also marked as a spawn
 * (`forkedFrom.spawned`, or `turns === 0` on older sessions) so the sidebar
 * nests it and so it cannot spawn further, and a parent holds at most
 * `MAX_NESTED_CHILDREN` of them.
 *
 * Two optional inputs. `context: 'fork'` starts the child with the parent's
 * conversation so far, copied the way `forkSession` copies it; it is still
 * unbound. `worktree: true` gives the child its own git worktree of the
 * parent's folder and write access limited to it, the way campaign tasks get
 * theirs; because that grants write authority, the user approves each one.
 */
import { jsonSchema, type Tool } from 'ai'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { ToolOutcome } from '@/lib/coworkRunner'
import { isReadOnly, type CoworkMode } from '@/lib/coworkMode'
import { SPAWN_SESSION_TOOL_NAME } from '@/lib/spawnSessionName'

export { SPAWN_SESSION_TOOL_NAME }
export const MAX_NESTED_CHILDREN = 5
const MAX_TITLE_CHARS = 120
const MAX_PROMPT_CHARS = 20_000

/** A session that was started by `spawn_session`, not forked by the user. */
export const isSpawnedSession = (s: Pick<CoworkSession, 'forkedFrom'>): boolean =>
  s.forkedFrom !== undefined &&
  (s.forkedFrom.spawned === true || s.forkedFrom.turns === 0)

export const spawnSessionTool: Tool = {
  description:
    'Start a nested chat: a new session, listed under this one in the sidebar, that begins working on `prompt` while you carry on. ' +
    'Unlike `task` (a subagent whose answer comes back to you), the user can open the nested chat, talk to it and stop it, and it does not report back unless you ask it to in the prompt. ' +
    'By default it starts with no folder access and none of your history, so make the prompt self-contained. ' +
    "Set `context: 'fork'` to start it with this conversation so far (still no folder access). " +
    "Set `worktree: true` to give it its own git worktree of this session's folder, with write access limited to it; the user must approve each such call, and it needs a folder attached and a mode that allows changes. " +
    'Use it for a long, separate line of work the user may want to steer; use `task` for a job whose answer you need.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        description: 'A short name for the nested chat, 3-6 words, shown in the sidebar.',
      },
      prompt: {
        type: 'string',
        minLength: 1,
        description:
          'The first message the nested chat is given. Self-contained unless context is fork.',
      },
      context: {
        type: 'string',
        enum: ['fresh', 'fork'],
        description:
          "'fresh' (default): the nested chat starts empty. 'fork': it starts with this conversation so far, then `prompt`.",
      },
      worktree: {
        type: 'boolean',
        description:
          "true: the nested chat gets its own git worktree and branch of this session's folder, with write access to it only. Needs the user's approval each time.",
      },
    },
    required: ['title', 'prompt'],
    additionalProperties: false,
  }),
} as Tool

type Input = {
  title?: unknown
  prompt?: unknown
  context?: unknown
  worktree?: unknown
}

/** What the dispatcher can offer a spawn: the caller's mode and its prompt. */
export type SpawnContext = {
  mode?: CoworkMode
  toolCallId?: string
  signal?: AbortSignal
  /** Absent where nothing can show a prompt (a subagent). */
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

export async function runSpawnSession(
  parentId: string,
  input: unknown,
  spawn: SpawnContext = {}
): Promise<ToolOutcome> {
  const raw = (input && typeof input === 'object' ? input : {}) as Input
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!title || !prompt) {
    return refuse('`spawn_session` needs a non-empty `title` and `prompt`.')
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return refuse(
      `\`prompt\` is ${prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}. Shorten it.`
    )
  }
  if (raw.context !== undefined && raw.context !== 'fork' && raw.context !== 'fresh') {
    return refuse("`context` must be 'fresh' or 'fork'.")
  }
  if (raw.worktree !== undefined && typeof raw.worktree !== 'boolean') {
    return refuse('`worktree` must be true or false.')
  }
  const fork = raw.context === 'fork'
  const worktree = raw.worktree === true

  // Imported when called: the stores pull in half the app, and this module is
  // reached from the dispatcher.
  const [{ useCoworkSessions }, { useMessageQueue }, { useSplitConversation }] =
    await Promise.all([
      import('@/hooks/useCoworkSessions'),
      import('@/stores/message-queue-store'),
      import('@/hooks/useSplitConversation'),
    ])

  const sessions = useCoworkSessions.getState().sessions
  const parent = sessions.find((s) => s.id === parentId)
  if (!parent) return refuse('this session no longer exists.')
  if (isSpawnedSession(parent)) {
    return refuse(
      'a nested chat cannot start another one. Do the work here, or ask the user.'
    )
  }
  const existing = sessions.filter(
    (s) => s.forkedFrom?.sessionId === parentId && isSpawnedSession(s)
  ).length
  if (existing >= MAX_NESTED_CHILDREN) {
    return refuse(
      `this session already has ${existing} nested chats, the most it may start. Wait for the user to close some.`
    )
  }

  const folder = parent.folder ?? null
  if (worktree) {
    if (!folder) {
      return refuse(
        '`worktree` needs a project folder attached to this session. Start the nested chat without it, or ask the user to attach a folder.'
      )
    }
    if (spawn.mode && isReadOnly(spawn.mode)) {
      return refuse(
        '`worktree` gives the nested chat write access, and this mode changes nothing. Start it without a worktree.'
      )
    }
    if (!spawn.onApprove && spawn.mode !== 'bypass') {
      return refuse(
        '`worktree` needs the approval of the user of a Cowork session, and nothing here can ask for it.'
      )
    }
  }

  // A fresh child has no folder and no grants, so it starts unprompted unless
  // the user turned on "ask before nested chats start" for this session. (A
  // worktree child is always asked, below.)
  if (!worktree) {
    const { useSessionMessaging } = await import('@/hooks/useSessionMessaging')
    if (useSessionMessaging.getState().askNested?.[parentId] === true) {
      if (!spawn.onApprove) {
        return refuse(
          'the user asks before nested chats start, and nothing here can ask them.'
        )
      }
      let allowed = false
      try {
        allowed = await spawn.onApprove(
          spawn.toolCallId ?? `spawn-${parentId}-${Date.now()}`,
          SPAWN_SESSION_TOOL_NAME,
          { title, worktree: false },
          undefined,
          spawn.signal
        )
      } catch {
        allowed = false
      }
      if (!allowed || spawn.signal?.aborted) {
        return refuse(
          'the user did not allow this nested chat. Do not retry it unchanged; do the work here or wait for instructions.'
        )
      }
    }
  }

  const now = Date.now()
  const shownTitle = title.slice(0, MAX_TITLE_CHARS)
  let id: string
  if (fork) {
    // The copy forkSession makes: turns, rebuilt messages, todos, goal and the
    // mode, and nothing that grants anything. forkSession selects the fork, so
    // the chat the user is reading is put back in front.
    const previous = useCoworkSessions.getState().currentId
    const forked = useCoworkSessions.getState().forkSession(parentId)
    if (!forked) return refuse('could not copy this conversation.')
    id = forked
    useCoworkSessions.setState((s) => ({
      currentId: previous,
      sessions: s.sessions.map((x) =>
        x.id === forked && x.forkedFrom
          ? {
              ...x,
              title: shownTitle,
              forkedFrom: { ...x.forkedFrom, spawned: true },
            }
          : x
      ),
    }))
  } else {
    id = crypto.randomUUID()
    const fresh = id
    // Added without selecting it: the chat the user is reading stays in front.
    useCoworkSessions.setState((s) => ({
      sessions: [
        {
          id: fresh,
          title: shownTitle,
          folder: null,
          turns: [],
          messages: [],
          forkedFrom: { sessionId: parentId, turns: 0, at: now, spawned: true },
          updated: now,
          createdAt: now,
        },
        ...s.sessions,
      ],
    }))
  }

  let branch = ''
  if (worktree && folder) {
    const undo = (reason: string): ToolOutcome => {
      useCoworkSessions.getState().deleteSession(id)
      return refuse(reason)
    }
    const [
      { useCoworkWorktrees },
      { useDirectEditGrants },
      { getServiceHub },
      { invokeCommand },
    ] = await Promise.all([
      import('@/hooks/useCoworkWorktrees'),
      import('@/hooks/useDirectEditGrants'),
      import('@/hooks/useServiceHub'),
      import('@/lib/backend'),
    ])
    const dataFolder = (await getServiceHub().app().getJanDataFolder()) ?? ''
    // Ask before anything touches the repository: the prompt names the branch
    // the worktree will use, computed the same way the backend names it.
    if (spawn.mode !== 'bypass') {
      let planned = ''
      try {
        planned = await invokeCommand<string>('agent_worktree_branch_name', {
          sessionId: id,
          title,
        })
      } catch {
        planned = ''
      }
      let allowed = false
      try {
        allowed = await spawn.onApprove!(
          spawn.toolCallId ?? `spawn-${id}`,
          SPAWN_SESSION_TOOL_NAME,
          { title, folder, branch: planned, worktree: true },
          undefined,
          spawn.signal
        )
      } catch {
        allowed = false
      }
      if (!allowed || spawn.signal?.aborted) {
        return undo(
          'the user did not allow a nested chat with its own worktree. Do not retry it unchanged; start it without `worktree`, or wait for instructions.'
        )
      }
    }
    // The project's folder is only the worktree's source; write access is
    // granted on the worktree below, never on the folder.
    useCoworkSessions.getState().setFolder(id, folder)
    const made = await useCoworkWorktrees
      .getState()
      .ensure(id, folder, dataFolder, { title })
    if (!made.ok) return undo(`could not create the worktree: ${made.reason}`)
    branch = made.record.branch
    const drop = async (reason: string): Promise<ToolOutcome> => {
      await useCoworkWorktrees
        .getState()
        .discard(id, dataFolder, true)
        .catch(() => undefined)
      return undo(reason)
    }
    const granted = await useDirectEditGrants
      .getState()
      .authorize(id, made.record.path, dataFolder, [])
    if (!granted.ok) {
      return drop(`could not give the worktree write access: ${granted.reason}`)
    }
    useCoworkSessions.getState().setAccess(id, 'managed-worktree')
  }

  useMessageQueue.getState().enqueue(id, {
    id: `spawn-seed-${id}`,
    text: prompt,
    createdAt: now,
  })
  // A pane makes it run now; with none free it waits, queued, until opened.
  const pane = useSplitConversation
    .getState()
    .addPane({ kind: 'cowork', refId: id })
  const started = pane !== 'full'

  return {
    output:
      `Started nested chat "${title}" (session_id=${id}). ` +
      (started
        ? 'It is running now, under this session in the sidebar.'
        : 'It is queued: no pane was free, so it starts when the user opens it.') +
      (worktree
        ? ` It has its own worktree of ${folder} on branch ${branch}, with write access to it only.`
        : ' It has no folder access.') +
      (fork ? ' It began with a copy of this conversation.' : '') +
      ' It will not report back unless your prompt told it to. ' +
      'Tell the user it exists; do not report anything it has done.',
  }
}
