/**
 * Type checks for an MCP server config typed or pasted as JSON.
 *
 * The JSON editor used to hand whatever parsed straight to the store, so a
 * number where a string belongs (`"command": 5`, `"args": [1, 2]`) reached
 * code that calls `.trim()` or `.slice()` on it and crashed the page. These
 * checks run before the save and name the offending field.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
}

/** The first problem with one server's config, or null when it is well typed. */
export function validateMcpServerConfig(
  config: unknown,
  name?: string
): string | null {
  const where = name ? `"${name}": ` : ''
  if (!isRecord(config)) return `${where}the server config must be an object.`
  const { command, args, env, url, headers, type, active, timeout } = config
  if (command !== undefined && typeof command !== 'string')
    return `${where}"command" must be a string.`
  if (url !== undefined && typeof url !== 'string')
    return `${where}"url" must be a string.`
  if (
    args !== undefined &&
    !(Array.isArray(args) && args.every((a) => typeof a === 'string'))
  )
    return `${where}"args" must be a list of strings.`
  if (env !== undefined && !stringMap(env))
    return `${where}"env" must be an object with string values.`
  if (headers !== undefined && !stringMap(headers))
    return `${where}"headers" must be an object with string values.`
  if (
    type !== undefined &&
    type !== 'stdio' &&
    type !== 'http' &&
    type !== 'sse'
  )
    return `${where}"type" must be "stdio", "http" or "sse".`
  if (active !== undefined && typeof active !== 'boolean')
    return `${where}"active" must be true or false.`
  if (timeout !== undefined && typeof timeout !== 'number')
    return `${where}"timeout" must be a number.`
  return null
}

/**
 * The first problem in what the JSON editor would save: one server's config,
 * a `{ name: config }` map, or `{ mcpServers, mcpSettings }`.
 */
export function validateMcpJson(
  data: unknown,
  serverName?: string | null
): string | null {
  if (serverName) return validateMcpServerConfig(data, serverName)
  if (!isRecord(data)) return 'The JSON must be an object.'
  const servers =
    'mcpServers' in data || 'mcpSettings' in data ? data.mcpServers : data
  if (servers === undefined) return null
  if (!isRecord(servers)) return '"mcpServers" must be an object.'
  for (const [key, config] of Object.entries(servers)) {
    const problem = validateMcpServerConfig(config, key)
    if (problem) return problem
  }
  return null
}
