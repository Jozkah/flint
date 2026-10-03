/**
 * The tool set advertised to a Cowork run.
 *
 * Schemas for the built-ins come from Rust (`toolSchemas()`), so there is one
 * source of truth for what they accept. The three client-only tools below are
 * transcribed from their Rust counterparts (`todo.rs`, `interaction.rs`,
 * `subagent.rs`) so the CLI and the desktop advertise the same contract.
 */
import { TEAM_TOOL_NAME } from '@/lib/coworkTeam'
import { jsonSchema, type Tool } from 'ai'
import { getAgentToolSchemas } from '@/lib/agentTools'
import {
  AWAIT_TASK_TOOL_NAME,
  BACKGROUND_TASK_TOOLS,
  CANCEL_TASK_TOOL_NAME,
  TASK_STATUS_TOOL_NAME,
} from '@/lib/coworkBackgroundTasks'
import {
  BRIEF_RULE,
  DELEGATE_WHEN,
  DO_NOT_DELEGATE,
  NOT_SHOWN_TO_USER,
  subagentChoices,
} from '@/lib/coworkSubagentGuide'
import type {
  ComponentReport,
  ToolSchema,
} from '@janhq/tauri-plugin-agent-tools-api'
import { isBrowserActionTool } from '@/lib/browserAgent'
import {
  SESSION_MESSAGING_TOOLS,
  STOP_SESSION_TOOL_NAME,
} from '@/lib/sessionMessagingTools'
import {
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_INPUT_SCHEMA,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_INPUT_SCHEMA,
} from '@/lib/webSearchTool'

/** Tools that can mutate something. Withheld, and refused, in plan mode. */
export const PLAN_DENIED_TOOLS = new Set([
  'write',
  'edit',
  'bash',
  'memory_write',
  'skill_write',
  'task',
])

/**
 * Browser tools that act on a page (click, type, press, select). Review mode
 * changes nothing, so they are withheld there and refused by the dispatcher.
 * Kept apart from PLAN_DENIED_TOOLS: those go through the edit-consent policy,
 * which has nothing to say about a web page, and the browser tools ask for
 * their own approval (lib/browserAgent.ts).
 */
export const isReviewDeniedBrowserTool = isBrowserActionTool

/** Named `todo` to match the Rust tool: the plan-mode addendum instructs the
 * model to call `todo` by name, so renaming it here breaks that prompt. */
export { TEAM_TOOL_NAME }
export const TODO_TOOL_NAME = 'todo'

export const ASK_TOOL_NAME = 'ask'
export const TASK_TOOL_NAME = 'task'

/** Tools Cowork dispatches itself rather than handing to the Rust plugin. */
export const CLIENT_TOOL_NAMES = new Set([
  TODO_TOOL_NAME,
  ASK_TOOL_NAME,
  TASK_TOOL_NAME,
  TEAM_TOOL_NAME,
  ...BACKGROUND_TASK_TOOLS,
])

const todoTool: Tool = {
  description:
    'Manage the canonical session todo list: init/start/done/drop/rm/append/view. One call applies one operation. Tasks advance automatically in phase and task order after done or drop; start only confirms the current task. init takes `list` or `items`, never `phase`/`task` directly. Mark a task done only if every part of it happened; if a check could not run, drop it and say why.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['init', 'start', 'done', 'drop', 'rm', 'append', 'view'],
      },
      list: {
        type: 'array',
        minItems: 1,
        description: 'For init: [{phase, items}]',
        items: {
          type: 'object',
          properties: {
            phase: { type: 'string' },
            items: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
            },
          },
          required: ['phase', 'items'],
          additionalProperties: false,
        },
      },
      items: {
        type: 'array',
        minItems: 1,
        description: 'For init (flat, single unnamed phase) or append.',
        items: { type: 'string', minLength: 1 },
      },
      task: { type: 'string', minLength: 1 },
      phase: { type: 'string', minLength: 1 },
      all: { type: 'boolean' },
    },
    required: ['op'],
    additionalProperties: false,
  }),
} as Tool

/**
 * What the model is told about `ask`. Mirrors `ASK_TOOL_DESCRIPTION` in
 * src-tauri/src/core/agent/interaction.rs; keep the two in step.
 */
export const ASK_TOOL_DESCRIPTION =
  'Ask the user one or more multiple-choice questions and wait for the answers. ' +
  "Use it when you need the user's input to proceed well: the request is ambiguous, there are several reasonable approaches " +
  'and the choice is theirs, or a preference (naming, scope, library, style) is missing. ' +
  'Do not ask what you can find out yourself by reading files or searching, and do not ask for permission to use tools. ' +
  'For each question propose 2-4 concrete options, each a short label with a one-line description of what it means or costs. ' +
  'Set `recommended` to the index of the option you would pick. Set `multi` when the choices are not exclusive. ' +
  'The user can always type their own answer instead, so never add an "Other" option. ' +
  'Batch related questions into one call rather than asking one at a time. ' +
  "Each answer comes back as the question followed by the chosen label(s) or the user's own text."

const askTool: Tool = {
  description: ASK_TOOL_DESCRIPTION,
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        description: 'One or more questions; batch related questions into one call.',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              minLength: 1,
              description:
                'Short stable key for this question, unique in the call (e.g. "db"). The answer comes back under it.',
            },
            question: {
              type: 'string',
              minLength: 1,
              description: 'The full question, one decision, ending with a question mark.',
            },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 5,
              description:
                '2-4 concrete choices you propose (at most 5). Do not add an "Other" option; the user can always type their own answer.',
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    minLength: 1,
                    description: 'A few words naming the choice.',
                  },
                  description: {
                    type: 'string',
                    description: 'One short line: what this choice means or its trade-off.',
                  },
                },
                required: ['label'],
                additionalProperties: false,
              },
            },
            multi: {
              type: 'boolean',
              description: 'true when choices are not exclusive and the user may pick several.',
            },
            recommended: {
              type: 'integer',
              minimum: 0,
              maximum: 4,
              description: '0-based index of the option you recommend; it is marked in the UI.',
            },
          },
          required: ['id', 'question', 'options'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  }),
} as Tool

/**
 * Several children on one piece of work, with an order between them.
 *
 * Separate from `task` rather than an option on it, because the interesting
 * part is the graph: what waits for what, and which tasks would collide. A
 * single call carrying the whole plan is what makes those answerable before
 * anything runs — asked one `task` at a time, they cannot be.
 */
/** What `team` tells the model; exported so its size and wording are tested. */
export function teamDescription(subagentNames: string[]): string {
  return [
    'Run several subagents on one piece of work. Independent tasks run at the same time (a few at once); `depends_on` orders the rest. ' +
      'Use it when the work splits into independent parts (one task per module, a review beside a test run) or when one part must finish before another starts. ' +
      'For a single job use `task`; do not use it for a lookup you can do yourself.',
    'Each child cannot see this chat, so every `description` must be a complete brief: the goal, the files or names involved, and what to report back. ' +
      "The user does not see the children's output: read the results and tell them what matters.",
    'Declare in `writes` the files or folders a task will change, and in `deletes` and `renames` what it removes or moves: ' +
      'when two unordered tasks would change the same paths, the user is shown the overlap before anything runs. ' +
      'Paths only read go in `reads` and never conflict. Set `isolate` on a task whose changes must not reach the attached folder or its siblings. ' +
      'Only the tester role has a shell, so do not ask the others to build or run tests. ' +
      'A reviewer of other tasks’ output must list them in `depends_on`.',
    subagentChoices(subagentNames),
  ].join('\n')
}

function teamTool(subagentNames: string[]): Tool {
  return {
    description: teamDescription(subagentNames),
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                description: 'Short, unique in this team.',
              },
              description: {
                type: 'string',
                minLength: 1,
                description: 'The whole brief; the child sees nothing else.',
              },
              subagent_name: { type: 'string', minLength: 1 },
              title: {
                type: 'string',
                description: 'A short name for this task, 3-6 words, shown on its row.',
              },
              depends_on: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                description: 'Task ids that must complete before this starts.',
              },
              writes: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                description:
                  'Files or folders this task expects to change, relative to the project.',
              },
              reads: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                description: 'Paths this task only reads. Never a conflict.',
              },
              deletes: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                description: 'Files or folders this task expects to delete.',
              },
              renames: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    from: { type: 'string', minLength: 1 },
                    to: { type: 'string', minLength: 1 },
                  },
                  required: ['from', 'to'],
                  additionalProperties: false,
                },
                description: 'Moves this task expects to make.',
              },
              retries: {
                type: 'integer',
                minimum: 0,
                maximum: 2,
                description:
                  'Extra attempts if this task fails, at most 2. Only worth ' +
                  'setting for work that can fail transiently; a refusal fails ' +
                  'the same way every time.',
              },
              isolate: {
                type: 'boolean',
                description:
                  'Give this task its own checkout of the project. Its ' +
                  'changes go nowhere else and nothing downstream can see ' +
                  'them, so a task that waits on an isolated task that ' +
                  'changes files is refused.',
              },
            },
            required: ['id', 'description'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    }),
  } as Tool
}

/**
 * What a surface can do with `task`. Cowork has a `team` to point at and a
 * checkout to isolate into; plain chat and Rooms have neither, so their copy of
 * the tool does not mention them.
 */
export type DelegationOptions = { team: boolean; isolate: boolean; background: boolean }
export const COWORK_DELEGATION: DelegationOptions = {
  team: true,
  isolate: true,
  background: true,
}

/** What `task` tells the model; exported so its size and wording are tested. */
export function taskDescription(
  subagentNames: string[],
  opts: DelegationOptions = COWORK_DELEGATION
): string {
  const how = opts.background
    ? 'By default this blocks until the subagent answers, and calls in one message run one after another. To run several at once, set background:true on each: it returns a task_id immediately and the subagent keeps working while you do other things; collect each with await_task (task_status checks on them, cancel_task stops one).' +
      (opts.team ? ' `team` runs a declared set with an order.' : '')
    : 'This blocks until the subagent answers, and calls in one message run one after another.'
  return [
    `Hand a self-contained job to a subagent: a nested agent with its own context and tools. ${BRIEF_RULE}`,
    DELEGATE_WHEN,
    DO_NOT_DELEGATE,
    how,
    NOT_SHOWN_TO_USER,
    `${subagentChoices(subagentNames)} For a one-off, give a descriptive subagent_name and a system_prompt.` +
      (opts.isolate
        ? ' Set isolate:true for a job that changes files you want reviewed first.'
        : ''),
  ].join('\n')
}

export function taskTool(
  subagentNames: string[],
  opts: DelegationOptions = COWORK_DELEGATION
): Tool {
  return {
    description: taskDescription(subagentNames, opts),
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        subagent_name: { type: 'string', minLength: 1 },
        title: {
          type: 'string',
          description: 'A short name for this errand, 3-6 words, shown on its row.',
        },
        description: { type: 'string', minLength: 1 },
        system_prompt: {
          type: 'string',
          minLength: 1,
          description: 'For a one-off subagent with no saved definition.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        ...(opts.isolate
          ? {
              isolate: {
                type: 'boolean' as const,
                description:
                  'Give this subagent a checkout of its own, so its file changes do not reach the attached folder until the user reviews them. Not combinable with allowed_tools or background.',
              },
            }
          : {}),
        ...(opts.background
          ? {
              background: {
                type: 'boolean' as const,
                description:
                  'Start it and return a task_id at once instead of waiting. Collect the answer with await_task.',
              },
            }
          : {}),
      },
      required: ['subagent_name', 'description'],
      additionalProperties: false,
    }),
  } as Tool
}

const taskIdProperty = {
  type: 'string' as const,
  minLength: 1,
  description: 'The task_id that `task` with background:true returned.',
}

export const awaitTaskTool: Tool = {
  description:
    'Wait for a background task to finish and return its final answer. If the answer comes back shortened, call again with the same task_id and an offset to read the omitted part. Can be called again for a task that already finished.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      task_id: taskIdProperty,
      offset: {
        type: 'integer',
        minimum: 0,
        description:
          'Only for an answer that came back shortened: the character to continue reading from.',
      },
    },
    required: ['task_id'],
    additionalProperties: false,
  }),
} as Tool

export const taskStatusTool: Tool = {
  description:
    'Say whether background tasks are running, done, failed or cancelled, and for how long. Without task_id it lists every background task of this run. Does not wait.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: { task_id: taskIdProperty },
    additionalProperties: false,
  }),
} as Tool

export const cancelTaskTool: Tool = {
  description:
    'Stop one background task. Its partial work is discarded. A task that already finished is left alone.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: { task_id: taskIdProperty },
    required: ['task_id'],
    additionalProperties: false,
  }),
} as Tool

/**
 * The delegation tools for a surface that is not Cowork: `task` with the
 * options it can honour, and the three tools that manage its background
 * children.
 */
export function delegationTools(
  subagentNames: string[],
  opts: DelegationOptions
): Record<string, Tool> {
  return {
    [TASK_TOOL_NAME]: taskTool(subagentNames, opts),
    ...(opts.background
      ? {
          [AWAIT_TASK_TOOL_NAME]: awaitTaskTool,
          [TASK_STATUS_TOOL_NAME]: taskStatusTool,
          [CANCEL_TASK_TOOL_NAME]: cancelTaskTool,
        }
      : {}),
  }
}

export type CoworkToolOptions = {
  planMode: boolean
  subagentNames: string[]
  /** Depth 1+ cannot spawn further subagents; mirrors the Rust loop's cap. */
  allowSubagents: boolean
  /**
   * Follows the global web-search setting, the same one chat reads. Cowork has
   * no toggle of its own: the surface configures nothing about its tool set, so
   * this is a Settings-level capability rather than a per-session choice.
   */
  webSearch: boolean
  /**
   * The folder this session is attached to, so readiness is probed for the
   * project the tools will actually work in rather than for nothing.
   */
  projectRoot?: string
  /**
   * The components only the renderer's stores can answer for -- provider
   * reachability, the resolved context window, MCP connection state. Rust
   * decides what they mean; see `environmentReadiness`.
   */
  reported?: ComponentReport[]
}

/**
 * The signature that must stay stable for the KV prefix to survive a run.
 *
 * Any change to advertised tool JSON changes the prompt prefix, and an agent
 * turn re-prefills 20+ times — so the record is frozen for a run's lifetime and
 * a mode change only takes effect on the next message.
 */
export function coworkToolSignature(
  opts: CoworkToolOptions,
  sandboxEnforces: boolean
): string {
  return [
    opts.planMode ? 'plan' : 'normal',
    sandboxEnforces ? 'jail' : 'nojail',
    opts.allowSubagents ? opts.subagentNames.join(',') : 'nosub',
    opts.webSearch ? 'web' : 'noweb',
    // Readiness is part of the signature because it changes the advertised
    // tools: a shell that starts after a retry must produce a different tool
    // set on the next message, and a signature that ignored it would keep
    // serving the old one for the life of the run.
    readinessSignature(opts.reported),
  ].join('|')
}

/**
 * The part of readiness that can change which tools are advertised.
 *
 * State and reason only -- not timestamps, which change on every probe and
 * would re-prefill a 20-turn agent run for no reason at all.
 */
function readinessSignature(reported: ComponentReport[] | undefined): string {
  if (!reported?.length) return 'noready'
  return reported
    .map((r) => `${r.component}:${r.state}`)
    .sort()
    .join(',')
}

/** Filter a name list down to what this mode may call. */
export function allowedToolNames(
  names: string[],
  opts: CoworkToolOptions
): string[] {
  return names.filter((name) => {
    if (opts.planMode && PLAN_DENIED_TOOLS.has(name)) return false
    if (opts.planMode && isReviewDeniedBrowserTool(name)) return false
    if (opts.planMode && name === STOP_SESSION_TOOL_NAME) return false
    if (
      (name === TASK_TOOL_NAME || BACKGROUND_TASK_TOOLS.has(name)) &&
      !opts.allowSubagents
    ) {
      return false
    }
    return true
  })
}

export async function buildCoworkTools(
  opts: CoworkToolOptions
): Promise<Record<string, Tool>> {
  // `session` scope: Cowork is the surface the backend offers the
  // session-messaging tools to. Those tools require a project identity, so a
  // folderless Cowork run must not advertise calls that are guaranteed to end
  // in `no_project`.
  const schemas = await getAgentToolSchemas(
    opts.projectRoot,
    opts.reported,
    'session'
  )
  const runnableSchemas = opts.projectRoot
    ? schemas
    : schemas.filter(
        (schema) => !SESSION_MESSAGING_TOOLS.has(schema.function.name)
      )
  return coworkToolsFromSchemas(runnableSchemas, opts)
}

/**
 * Cowork's outer tool lifecycle currently hard-stops one foreground `bash`
 * call at 120 seconds. The backend schema historically allowed any integer,
 * so the model could request 300/600/900 seconds and still be killed at 120.
 * Make the advertised contract match the execution contract. Long work should
 * be started as a background job (background:true, omit timeout), which returns
 * a job id immediately instead of burning the run's wall-clock budget.
 */
export const COWORK_BASH_FOREGROUND_TIMEOUT_MAX = 120

function coworkBuiltinSchema(s: ToolSchema): {
  description: string
  parameters: Record<string, unknown>
} {
  if (s.function.name !== 'bash') {
    return {
      description: s.function.description,
      parameters: s.function.parameters as Record<string, unknown>,
    }
  }

  const parameters = JSON.parse(
    JSON.stringify(s.function.parameters)
  ) as Record<string, unknown>
  const properties = parameters.properties as
    | Record<string, Record<string, unknown>>
    | undefined
  if (properties?.timeout) {
    properties.timeout.maximum = COWORK_BASH_FOREGROUND_TIMEOUT_MAX
    properties.timeout.description =
      'Seconds to wait, at most 120. For work that may take longer, set background:true and omit timeout so the call returns a job_id immediately.'
  }
  return {
    description:
      s.function.description +
      ' A foreground call may wait at most 120 seconds. For longer commands use background:true and omit timeout; collect the returned job_id later instead of increasing timeout.',
    parameters,
  }
}

/**
 * The advertised tool set from the backend's schemas, with no I/O.
 *
 * Split from `buildCoworkTools` so the session details can measure the tool
 * set a run would send without probing readiness, spawning anything or asking
 * for a grant: everything here is plain schema construction.
 */
export function coworkToolsFromSchemas(
  schemas: readonly ToolSchema[],
  opts: Pick<
    CoworkToolOptions,
    'planMode' | 'webSearch' | 'allowSubagents' | 'subagentNames'
  >
): Record<string, Tool> {
  const tools: Record<string, Tool> = {}

  for (const s of schemas) {
    const name = s.function.name
    if (opts.planMode && PLAN_DENIED_TOOLS.has(name)) continue
    if (opts.planMode && isReviewDeniedBrowserTool(name)) continue
    // Review (plan) mode changes nothing, and stopping another session's run
    // is a change. Withheld here and refused by the dispatcher too.
    if (opts.planMode && name === STOP_SESSION_TOOL_NAME) continue
    const schema = coworkBuiltinSchema(s)
    tools[name] = {
      description: schema.description,
      inputSchema: jsonSchema(schema.parameters),
    } as Tool
  }

  // Reads, so plan mode keeps them: research is most of what planning is.
  if (opts.webSearch) {
    tools['web_search'] = {
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: jsonSchema(
        WEB_SEARCH_INPUT_SCHEMA as Record<string, unknown>
      ),
    } as Tool
    tools['web_fetch'] = {
      description: WEB_FETCH_DESCRIPTION,
      inputSchema: jsonSchema(
        WEB_FETCH_INPUT_SCHEMA as Record<string, unknown>
      ),
    } as Tool
  }

  tools[TODO_TOOL_NAME] = todoTool
  tools[ASK_TOOL_NAME] = askTool
  if (opts.allowSubagents && !opts.planMode) {
    tools[TASK_TOOL_NAME] = taskTool(opts.subagentNames)
    tools[TEAM_TOOL_NAME] = teamTool(opts.subagentNames)
    tools[AWAIT_TASK_TOOL_NAME] = awaitTaskTool
    tools[TASK_STATUS_TOOL_NAME] = taskStatusTool
    tools[CANCEL_TASK_TOOL_NAME] = cancelTaskTool
  }
  return tools
}
