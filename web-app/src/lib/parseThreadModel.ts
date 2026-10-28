export type ThreadModel = {
  id: string
  provider: string
}

/**
 * The `threadModel` search param comes straight from the URL, so it is only
 * trusted when it is an object with a string id and a string provider.
 */
export function parseThreadModel(value: unknown): ThreadModel | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { id, provider } = value as Record<string, unknown>
  if (typeof id !== 'string' || typeof provider !== 'string') return undefined
  return { id, provider }
}
