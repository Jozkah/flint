/** Explain tool markup emitted as plain text, which never executes a tool. */
export function explainRawToolCall(text: string): string {
  return text.replace(
    /<tool_call>\s*<function=[\s\S]*?(?:<\/tool_call>|$)/gi,
    'Tool call was emitted as text. No tool ran. Select a model with working tool support and try again.'
  )
}
