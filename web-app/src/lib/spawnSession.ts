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
 * (`forkedFrom.turns === 0`) so the sidebar nests it and so it cannot spawn
 * further, and a parent holds at most `MAX_NESTED_CHILDREN` of them.
 */
import { jsonSchema, type Tool } from 'ai'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { ToolOutcome } from '@/lib/coworkRunner'

export const SPAWN_SESSION_TOOL_NAME = 'spawn_session'
export const MAX_NESTED_CHILDREN = 5
const MAX_TITLE_CHARS = 120
const MAX_PROMPT_CHARS = 20_000

/** A session that was started by `spawn_session`, not forked by the user. */
export const isSpawnedSession = (s: Pick<CoworkSession, 'forkedFrom'>): boolean =>
  s.forkedFrom !== undefined && s.forkedFrom.turns === 0

export const spawnSessionTool: Tool = {
  description:
    'Start a nested chat: a new session, listed under this one in the sidebar, that begins working on `prompt` while you carry on. ' +
    'Unlike `task` (a subagent whose answer comes back to you), the user can open the nested chat, talk to it and stop it, and it does not report back unless you ask it to in the prompt. ' +
    'It starts with no folder access and none of your history, so make the prompt self-contained. ' +
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
        description: 'The first message the nested chat is given. Self-contained.',
      },
    },
    required: ['title', 'prompt'],
    additionalProperties: false,
  }),
} as Tool

type Input = { title?: unknown; prompt?: unknown }

const refuse = (output: string): ToolOutcome => ({
  output: `ERROR: ${output}`,
  isError: true,
})

export async function runSpawnSession(
  parentId: string,
  input: unknown
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

  const id = crypto.randomUUID()
  const now = Date.now()
  // Added without selecting it: the chat the user is reading stays in front.
  useCoworkSessions.setState((s) => ({
    sessions: [
      {
        id,
        title: title.slice(0, MAX_TITLE_CHARS),
        folder: null,
        turns: [],
        messages: [],
        forkedFrom: { sessionId: parentId, turns: 0, at: now },
        updated: now,
        createdAt: now,
      },
      ...s.sessions,
    ],
  }))
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
      ' It has no folder access and will not report back unless your prompt told it to. ' +
      'Tell the user it exists; do not report anything it has done.',
  }
}
