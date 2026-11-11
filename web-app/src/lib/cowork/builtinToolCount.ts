/**
 * How many advertised tools are Flint's own. The readiness card prints this
 * as "N built-in" beside the MCP server names, so MCP tools are left out:
 * counting them made 28 built-in tools and 476 MCP tools read "504 built-in".
 */
export function builtinToolCount(
  advertised: readonly string[],
  mcpServerFor: (name: string) => string | undefined
): number {
  return advertised.filter((name) => mcpServerFor(name) === undefined).length
}
