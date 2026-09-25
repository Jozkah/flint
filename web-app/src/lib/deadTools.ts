/**
 * Tools that cannot work in this conversation, and names the model invented
 * (transcript audit #11).
 *
 * An MCP server can advertise a tool its backend does not implement: every
 * call then fails with "Method not found", and a model that is still offered
 * the tool calls it again. Once a server answers that way the tool is dead for
 * the rest of the conversation: it is no longer offered, and a call to it is
 * answered here without reaching the server.
 *
 * A call to a name that was never offered gets the closest offered names, so
 * the model can correct a typo instead of guessing again.
 */

const dead = new Map<string, Map<string, string>>()

/** Whether an MCP result says the server does not implement the method. */
export function isMethodNotFound(text: string | undefined | null): boolean {
  if (!text) return false
  return (
    /method\s+'?[^'\s]*'?\s*not\s+found/i.test(text) ||
    /\b-32601\b/.test(text)
  )
}

/** Mark `tool` dead for `threadId`, keeping why. */
export function markToolDead(threadId: string, tool: string, why: string) {
  let tools = dead.get(threadId)
  if (!tools) {
    tools = new Map()
    dead.set(threadId, tools)
  }
  tools.set(tool, why)
}

/** The tools dead in `threadId`. */
export function deadTools(threadId: string | undefined): string[] {
  if (!threadId) return []
  return [...(dead.get(threadId)?.keys() ?? [])].sort()
}

/** The refusal for a call to a tool already found dead, or null. */
export function deadToolRefusal(
  threadId: string,
  tool: string
): string | null {
  const why = dead.get(threadId)?.get(tool)
  if (why === undefined) return null
  return `Tool '${tool}' is disabled for the rest of this conversation: its server does not implement it (${why}). It was not called. Do not call it again; use another tool or tell the user.`
}

/** The note the model gets on the call that found the tool dead. */
export function deadToolNote(tool: string): string {
  return `\n\nNote: '${tool}' is advertised by its server but not implemented ("Method not found"). It has been disabled for the rest of this conversation; do not call it again.`
}

/** Forget a conversation's dead tools (tests, or a thread that is gone). */
export function forgetDeadTools(threadId?: string) {
  if (threadId === undefined) dead.clear()
  else dead.delete(threadId)
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
      diag = up
    }
  }
  return prev[b.length]
}

/** Up to `max` offered names close to `name`, closest first. */
export function closeToolNames(
  name: string,
  offered: Iterable<string>,
  max = 5
): string[] {
  const want = name.toLowerCase()
  const scored: [number, string][] = []
  for (const candidate of offered) {
    const c = candidate.toLowerCase()
    const d = distance(want, c)
    const near = d <= Math.max(2, Math.floor(want.length / 3))
    const contains = want.length >= 3 && (c.includes(want) || want.includes(c))
    const sameTail =
      want.includes('_') && c.endsWith(want.slice(want.lastIndexOf('_')))
    if (near || contains || sameTail) scored.push([contains ? d - 1 : d, candidate])
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
    .slice(0, max)
    .map(([, n]) => n)
}

/** The error for a call to a tool that was not offered. */
export function unknownToolError(name: string, offered: Iterable<string>): string {
  const all = [...offered]
  const near = closeToolNames(name, all)
  const hint = near.length
    ? ` Did you mean: ${near.map((n) => `'${n}'`).join(', ')}?`
    : all.length
      ? ` Available tools: ${all.slice(0, 40).join(', ')}${all.length > 40 ? ', ...' : ''}.`
      : ' No tools are available in this conversation.'
  return `Tool '${name}' does not exist here and was not run.${hint} Call only tools from the list you were given.`
}
