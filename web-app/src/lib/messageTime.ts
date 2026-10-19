/**
 * A stored message time as milliseconds. It is a Date while the message is in
 * memory, a number in a thread file and an ISO string after a JSON round trip
 * through a persisted store; all three are the same instant. Anything else has
 * no time: a caller must not substitute "now", which is how a message read as
 * freshly sent every time its conversation was reopened.
 */
export function toMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isFinite(t) ? t : undefined
  }
  if (typeof value === 'number')
    return Number.isFinite(value) && value > 0 ? value : undefined
  if (typeof value === 'string' && value) {
    const t = Date.parse(value)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

/**
 * When the reply a request continues began. A request that ends on an
 * assistant message (sent after a tool ran) extends that reply, so its time is
 * the reply's first one, not the time of the later request.
 */
export function earlierCreatedAt(
  messages: readonly { role: string; metadata?: unknown }[]
): number | undefined {
  const last = messages[messages.length - 1]
  if (last?.role !== 'assistant') return undefined
  return toMs((last.metadata as { createdAt?: unknown } | undefined)?.createdAt)
}
