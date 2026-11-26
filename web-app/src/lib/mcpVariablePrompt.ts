import { create } from 'zustand'
import { useMcpPlaceholders } from '@/hooks/useMcpPlaceholders'
import { type McpSessionVars, missingVariables } from '@/lib/mcpSessionVars'

/**
 * The question asked when the model calls a tool of a template MCP server
 * and its session leaves some of the server's `{{var}}` values unset. Shown
 * by `McpVariablesPromptDialog`, mounted once at the root, one at a time.
 */
type Request = {
  server: string
  missing: string[]
  resolve: (values: McpSessionVars | null) => void
}

export const useMcpVariablePrompt = create<{ request: Request | null }>(() => ({
  request: null,
}))

/** Settle the open question: the values entered, or `null` for cancel. */
export function answerMcpVariablePrompt(values: McpSessionVars | null): void {
  const request = useMcpVariablePrompt.getState().request
  if (!request) return
  useMcpVariablePrompt.setState({ request: null })
  request.resolve(values)
}

let queue: Promise<unknown> = Promise.resolve()

/** Ask for `missing` values of `server`; one dialog at a time, in order. */
export function askMcpVariables(
  server: string,
  missing: string[]
): Promise<McpSessionVars | null> {
  const next = queue.then(
    () =>
      new Promise<McpSessionVars | null>((resolve) => {
        useMcpVariablePrompt.setState({ request: { server, missing, resolve } })
      })
  )
  queue = next.catch(() => undefined)
  return next
}

/**
 * The values a call to `server` should carry. When the session leaves some
 * of them unset, the user is asked; what they enter is saved with `save` and
 * merged in. `null` when they cancel. A server that is no template, or
 * `undefined`, returns `vars` as is.
 */
export async function ensureMcpVariables(
  server: string | undefined,
  vars: McpSessionVars | undefined,
  save: (vars: McpSessionVars) => void,
  ask: typeof askMcpVariables = askMcpVariables
): Promise<McpSessionVars | undefined | null> {
  if (!server) return vars
  const placeholders = useMcpPlaceholders.getState().placeholders
  const missing = missingVariables(placeholders, server, vars)
  if (missing.length === 0) return vars
  const entered = await ask(server, missing)
  if (!entered) return null
  const merged = { ...(vars ?? {}), ...entered }
  if (missingVariables(placeholders, server, merged).length > 0) return null
  save(merged)
  return merged
}

/** The tool error for a call whose variables the user did not provide. */
export function variablesDeclinedError(server: string, missing: string[]): string {
  const names = missing.map((n) => `{{${n}}}`).join(', ')
  return `MCP server '${server}' needs session variables that are not set: ${names}. The user did not set them, so the tool was not run.`
}
