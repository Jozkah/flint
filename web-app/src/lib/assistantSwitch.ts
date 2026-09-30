type NamedMessage = {
  role: string
  metadata?: unknown
}

const nameOf = (m: NamedMessage | undefined): string | undefined => {
  const name = (m?.metadata as { assistantName?: unknown } | undefined)?.assistantName
  return typeof name === 'string' && name ? name : undefined
}

/**
 * The name of the assistant that answered before this reply, when it is a
 * different one from the assistant answering this reply. Undefined for a user
 * message, for the first reply, and when either reply carries no name.
 */
export function switchedFromOf(
  messages: readonly NamedMessage[],
  index: number
): string | undefined {
  const current = messages[index]
  if (!current || current.role !== 'assistant') return undefined
  const here = nameOf(current)
  if (!here) return undefined
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    const before = nameOf(messages[i])
    return before && before !== here ? before : undefined
  }
  return undefined
}
