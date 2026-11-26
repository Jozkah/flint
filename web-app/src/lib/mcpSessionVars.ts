/**
 * Per-session MCP variables.
 *
 * An MCP server config may name a variable as `{{name}}` in its args, env,
 * url or headers (`http://127.0.0.1:{{obsidian_port}}/mcp`). Such a server is
 * a template: each chat, cowork session or room supplies its own values, and
 * the backend runs one instance of the server per distinct set of values.
 *
 * The backend reports which variables each enabled template uses
 * (`get_mcp_session_placeholders`); this module works out, for one session,
 * which templates it leaves unresolved, so their tools can be withheld in
 * Auto mode and a call to one can ask for the missing values first.
 */

/** A session's variable values, by name. */
export type McpSessionVars = Record<string, string>

/** The variables each enabled template uses, by server name. */
export type McpPlaceholders = Record<string, string[]>

/** A variable name, as the backend accepts it inside `{{ }}`. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME.test(name)
}

/** A value counts as set when it is not blank. */
function isSet(vars: McpSessionVars | undefined, name: string): boolean {
  const value = vars?.[name]
  return typeof value === 'string' && value.trim() !== ''
}

/** The variables `server` needs that `vars` leaves unset. */
export function missingVariables(
  placeholders: McpPlaceholders,
  server: string | undefined,
  vars: McpSessionVars | undefined
): string[] {
  if (!server) return []
  return (placeholders[server] ?? []).filter((name) => !isSet(vars, name))
}

/** The templates `vars` leaves at least one variable of unset. */
export function unresolvedServers(
  placeholders: McpPlaceholders,
  vars: McpSessionVars | undefined
): Set<string> {
  const out = new Set<string>()
  for (const server of Object.keys(placeholders)) {
    if (missingVariables(placeholders, server, vars).length > 0) out.add(server)
  }
  return out
}

/** Every variable any enabled template uses, sorted. */
export function allVariableNames(placeholders: McpPlaceholders): string[] {
  const names = new Set<string>()
  Object.values(placeholders).forEach((list) => list.forEach((n) => names.add(n)))
  return [...names].sort()
}

/** The servers that use variable `name`, sorted. */
export function serversUsing(
  placeholders: McpPlaceholders,
  name: string
): string[] {
  return Object.entries(placeholders)
    .filter(([, list]) => list.includes(name))
    .map(([server]) => server)
    .sort()
}

/** `tools` without those of the templates in `unresolved`. */
export function withoutUnresolved<T extends { server?: string }>(
  tools: T[],
  unresolved: Set<string>
): T[] {
  if (unresolved.size === 0) return tools
  return tools.filter((t) => !t.server || !unresolved.has(t.server))
}

/**
 * `vars` cleaned for storage and for the backend: invalid names and blank
 * values dropped, values kept exactly as typed otherwise. `undefined` when
 * nothing is left, so an empty set is not written into session metadata.
 */
export function normalizeVars(
  vars: McpSessionVars | undefined
): McpSessionVars | undefined {
  if (!vars) return undefined
  const out: McpSessionVars = {}
  for (const [name, value] of Object.entries(vars)) {
    const key = name.trim()
    if (!isValidVariableName(key)) continue
    if (typeof value !== 'string' || value.trim() === '') continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** `vars` read from untyped session metadata. */
export function varsFromMetadata(
  metadata: Record<string, unknown> | undefined
): McpSessionVars | undefined {
  const raw = metadata?.mcpVariables
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: McpSessionVars = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return normalizeVars(out)
}

/**
 * The model-facing note for templates whose tools were withheld because the
 * session leaves their variables unset, or `null` when none were.
 */
export function unresolvedNote(
  withheld: Iterable<string>,
  placeholders: McpPlaceholders,
  vars: McpSessionVars | undefined
): string | null {
  const parts = [...withheld].sort().map((server) => {
    const names = missingVariables(placeholders, server, vars)
      .map((n) => `{{${n}}}`)
      .join(', ')
    return `${server} (${names})`
  })
  if (parts.length === 0) return null
  return `MCP server ${parts.join('; ')} needs session variables that are not set, so its tools are not offered. Ask the user to set them in this session's MCP variables if they want to use it.`
}

const PLACEHOLDER = /\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}/

/**
 * Does this server config use a `{{var}}` placeholder (in args, env, url or
 * headers)? Such a server is a template: it is enabled, but it only runs as
 * a session's instance, so it never shows as connected on its own.
 */
export function configUsesPlaceholders(config: {
  args?: unknown
  env?: unknown
  url?: unknown
  headers?: unknown
}): boolean {
  const strings: string[] = []
  const collect = (v: unknown) => {
    if (typeof v === 'string') strings.push(v)
    else if (Array.isArray(v)) v.forEach(collect)
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  ;[config.args, config.env, config.url, config.headers].forEach(collect)
  return strings.some((s) => PLACEHOLDER.test(s))
}
