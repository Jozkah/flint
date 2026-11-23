/**
 * An MCP tool reports failure with `isError: true` and its message in
 * `content` (text blocks), not with an `error` field. Chat recorded such a
 * call as a success, so its card read "Used 1 tool" and the empty-run fallback
 * could not name the failure. This is the text to show for one, or undefined
 * when the result is not a failure.
 */
export function mcpFailureText(result: {
  error?: unknown
  isError?: unknown
  content?: unknown
}): string | undefined {
  if (result.error) return String(result.error)
  if (result.isError !== true) return undefined
  const { content } = result
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .filter((t) => t.trim())
      .join('\n')
    if (text) return text
  }
  return content === undefined || content === null || content === ''
    ? 'The tool reported an error with no message.'
    : JSON.stringify(content)
}
