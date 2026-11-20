/**
 * When a provider rejects image input (a model marked as vision-capable that
 * has none, or whose only reachable endpoints have none), the image stays in
 * the thread history and is resent every turn, so every later turn in that
 * thread fails the same way. These helpers let the fetch wrapper retry once
 * with each image replaced by a short text note.
 */

export const IMAGE_REJECTED_STAND_IN =
  '(image omitted: the model does not accept image input)'

/**
 * Heuristic: does this upstream error say the model cannot take images?
 * Catches OpenRouter's "No endpoints found that support image input",
 * llama.cpp's "image input is not supported" (no mmproj), OpenAI's
 * "image_url is only supported by certain models" and DeepSeek's
 * "unknown variant `image_url`".
 */
export function isImageInputRejection(message: string): boolean {
  if (typeof message !== 'string') return false
  return (
    /support(s)? image input/i.test(message) ||
    /(image|vision|multimodal)\b[^.\n]{0,40}\bnot supported/i.test(message) ||
    /does not support (image|vision)/i.test(message) ||
    /image_url is only supported/i.test(message) ||
    /unknown variant [`'"]?image_url/i.test(message)
  )
}

// The text part that takes an image part's place, in the image part's own
// wire dialect. Null when `part` is not an image.
function imageStandIn(part: unknown): Record<string, unknown> | null {
  if (!part || typeof part !== 'object') return null
  const p = part as Record<string, unknown>
  // OpenAI chat completions.
  if (p.type === 'image_url') return { type: 'text', text: IMAGE_REJECTED_STAND_IN }
  // Anthropic messages, including inside a tool_result's content.
  if (p.type === 'image' && p.source) {
    return { type: 'text', text: IMAGE_REJECTED_STAND_IN }
  }
  // OpenAI Responses.
  if (p.type === 'input_image') {
    return { type: 'input_text', text: IMAGE_REJECTED_STAND_IN }
  }
  // Gemini.
  const inline = (p.inlineData ?? p.inline_data) as
    | { mimeType?: unknown; mime_type?: unknown }
    | undefined
  const mime = inline?.mimeType ?? inline?.mime_type
  if (typeof mime === 'string' && mime.startsWith('image/')) {
    return { text: IMAGE_REJECTED_STAND_IN }
  }
  return null
}

function replaceImageParts(node: unknown): number {
  if (!node || typeof node !== 'object') return 0
  let replaced = 0
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const standIn = imageStandIn(node[i])
      if (standIn) {
        node[i] = standIn
        replaced++
      } else {
        replaced += replaceImageParts(node[i])
      }
    }
    return replaced
  }
  for (const value of Object.values(node)) replaced += replaceImageParts(value)
  return replaced
}

/**
 * Replaces every image part in an outgoing request body with a short text
 * note, in whichever provider dialect the body uses. A `role: tool` message
 * left with only text goes back to a plain string. Mutates `body` in place;
 * returns how many images it removed.
 */
export function stripImagePartsInBody(body: Record<string, unknown>): number {
  let replaced = 0
  for (const [key, value] of Object.entries(body)) {
    if (key !== 'messages' || !Array.isArray(value)) {
      replaced += replaceImageParts(value)
      continue
    }
    for (const msg of value) {
      const count = replaceImageParts(msg)
      replaced += count
      const m = msg as { role?: string; content?: unknown }
      if (count === 0 || m?.role !== 'tool' || !Array.isArray(m.content)) continue
      const parts = m.content as Array<{ type?: unknown; text?: unknown }>
      if (
        parts.every((part) => part?.type === 'text' && typeof part.text === 'string')
      ) {
        m.content = parts.map((part) => part.text).join(' ')
      }
    }
  }
  return replaced
}
