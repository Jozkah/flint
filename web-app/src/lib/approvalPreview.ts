/** A one-line look at what the call would do: its command, path or first argument. */
export function approvalPreviewText(input: unknown): string | null {
  if (input == null) return null
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)
  const o = input as Record<string, unknown>
  for (const k of ['command', 'cmd', 'path', 'file_path', 'url', 'query']) {
    if (typeof o[k] === 'string' && o[k]) return o[k] as string
  }
  const first = Object.values(o).find((v) => typeof v === 'string' && v)
  return typeof first === 'string' ? first : null
}
