/** Explain tool markup emitted as plain text, which never executes a tool. */
export function explainRawToolCall(text: string): string {
  return text.replace(
    /<tool_call>\s*<function=[\s\S]*?(?:<\/tool_call>|$)/gi,
    'Tool call was emitted as text. No tool ran. Check this model’s tool support and try again.'
  )
}

export function hasRawToolCall(text: string): boolean {
  return /<tool_call>\s*<function=/i.test(text)
}
