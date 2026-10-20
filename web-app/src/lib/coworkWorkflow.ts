/**
 * The `workflow` tool: ordered phases of parallel subagents.
 *
 * A thin front end over the `team` scheduler, not a second one. Each agent
 * becomes a team task; every task in a phase depends on every task of the
 * phase before, and carries those answers into its brief. Caps, depth, budget,
 * cancellation and the Tasks panel all come from `team`.
 */

import { jsonSchema, type Tool } from 'ai'
import { MAX_TEAM_TASKS } from '@/lib/coworkTeam'
import { schemaProblem } from '@/lib/coworkWorkflowSchema'

import { WORKFLOW_TOOL_NAME } from '@/lib/workflowToolName'

export { WORKFLOW_TOOL_NAME }

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Turn a workflow request into a `team` request, or a sentence naming the
 * field that is wrong (returned to the model as the tool result).
 */
export function workflowToTeamInput(
  raw: unknown
): { tasks: Raw[] } | string {
  if (!isObject(raw) || !Array.isArray(raw.phases) || raw.phases.length === 0) {
    return 'workflow needs a non-empty `phases` array'
  }
  const tasks: Raw[] = []
  const seen = new Set<string>()
  let previous: string[] = []
  for (const [p, phase] of raw.phases.entries()) {
    const at = `phases[${p}]`
    if (!isObject(phase)) return `${at} must be an object`
    if (!Array.isArray(phase.agents) || phase.agents.length === 0) {
      return `${at}.agents must be a non-empty array`
    }
    const ids: string[] = []
    for (const [a, agent] of phase.agents.entries()) {
      const where = `${at}.agents[${a}]`
      if (!isObject(agent)) return `${where} must be an object`
      const description = text(agent.description)
      if (!description) {
        return `${where}.description is empty; the agent sees nothing else`
      }
      if (agent.schema !== undefined) {
        const problem = schemaProblem(agent.schema, `${where}.schema`)
        if (problem) return problem
      }
      const id = text(agent.id) || `p${p + 1}a${a + 1}`
      if (seen.has(id)) return `${where}.id '${id}' appears twice`
      seen.add(id)
      ids.push(id)
      const title = text(agent.title) || text(phase.name)
      const subagent = text(agent.subagent_name)
      tasks.push({
        id,
        description,
        ...(subagent ? { subagent_name: subagent } : {}),
        ...(title ? { title } : {}),
        ...(isObject(agent.schema) ? { schema: agent.schema } : {}),
        phase: { name: text(phase.name) || `Phase ${p + 1}`, index: p },
        ...(previous.length ? { depends_on: previous, carry: previous } : {}),
      })
    }
    previous = ids
  }
  if (tasks.length > MAX_TEAM_TASKS) {
    return `phases hold ${tasks.length} agents in all; at most ${MAX_TEAM_TASKS}`
  }
  return { tasks }
}

export function workflowTool(subagentNames: string[]): Tool {
  const named = subagentNames.length
    ? ` Saved subagents for \`subagent_name\`: ${subagentNames.join(', ')}.`
    : ''
  return {
    description:
      'Run a multi-phase job. Phases run in order; the agents inside one phase run in parallel; ' +
      'each agent in a later phase is given every earlier-phase answer ahead of its own brief. ' +
      'Returns one combined report. Use for survey-then-act or fan-out-then-merge jobs; for one ' +
      'job use `task`, for a dependency graph use `team`. Each agent cannot see this chat, so ' +
      'every `description` must be a complete brief.' +
      named,
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        background: {
          type: 'boolean',
          description:
            'Start it and return a task_id at once; collect the combined report with await_task, ' +
            'check task_status, or cancel_task. Default false.',
        },
        control: {
          type: 'object',
          description:
            'Steer a RUNNING background workflow instead of starting one (give only this field). ' +
            '`pause` starts no new agent (running ones finish); `resume` undoes it; `restart` stops one ' +
            'agent and runs it again (`agent_id` required).',
          properties: {
            run_id: { type: 'string', minLength: 1, description: 'The task_id the workflow returned.' },
            action: { type: 'string', enum: ['pause', 'resume', 'restart'] },
            agent_id: { type: 'string', minLength: 1, description: 'For restart: the agent id.' },
          },
          required: ['run_id', 'action'],
          additionalProperties: false,
        },
        phases: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Phase label, e.g. "Audit".' },
              agents: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', minLength: 1, description: 'Optional; unique in the workflow.' },
                    subagent_name: { type: 'string', minLength: 1 },
                    title: { type: 'string', description: 'Short row name, 3-6 words.' },
                    description: { type: 'string', minLength: 1, description: 'The whole brief.' },
                    schema: {
                      type: 'object',
                      description:
                        'Optional JSON schema an agent answer must match. It is checked and the agent retried; later phases receive the parsed JSON.',
                    },
                  },
                  required: ['description'],
                  additionalProperties: false,
                },
              },
            },
            required: ['agents'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    }),
  } as Tool
}
