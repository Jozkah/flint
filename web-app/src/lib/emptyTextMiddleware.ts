import type {
  LanguageModelV3Middleware,
  LanguageModelV3Prompt,
} from '@ai-sdk/provider'

/**
 * Removes empty text parts from the prompt before it reaches Anthropic.
 *
 * Anthropic answers 400 "text content blocks must be non-empty" (or, for
 * whitespace, "must contain non-whitespace text") when a message carries a
 * `{type:"text", text:""}` block. Those appear when an assistant turn has an
 * empty text part next to a tool call, or when a turn was left empty by a
 * failed generation. Other parts are kept, and a message left with no content
 * at all is dropped.
 */
export function stripEmptyTextParts(
  prompt: LanguageModelV3Prompt
): LanguageModelV3Prompt {
  const out: LanguageModelV3Prompt = []
  for (const message of prompt) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      out.push(message)
      continue
    }
    const content = (message.content as Array<{ type: string; text?: string }>).filter(
      (part) =>
        part.type !== 'text' ||
        (typeof part.text === 'string' && part.text.trim().length > 0)
    )
    if (content.length === 0) continue
    out.push({ ...message, content } as LanguageModelV3Prompt[number])
  }
  return out
}

export function emptyTextMiddleware(): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => ({
      ...params,
      prompt: stripEmptyTextParts(params.prompt),
    }),
  }
}
