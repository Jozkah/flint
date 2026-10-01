import type { UIMessage } from '@ai-sdk/react'

/**
 * A tool result can carry an image (an MCP screenshot tool, for one). The AI
 * SDK sends a tool result to the model as a `role: "tool"` message made with
 * `JSON.stringify`, so the whole base64 string goes in as text and is tokenized
 * in full. One screenshot is enough to overflow a local model's context and
 * fail the next request.
 *
 * This produces the copy of the conversation that is sent to the model: image
 * blocks in tool results are replaced by a short note, and for a model that can
 * see, the images are attached again as a proper image part in a user message
 * right after the tool turn. The stored conversation is left as it is.
 */

type UnknownRecord = Record<string, unknown>

const isImageBlock = (block: unknown): block is UnknownRecord =>
  !!block &&
  typeof block === 'object' &&
  (block as UnknownRecord).type === 'image'

/**
 * The base64 payload and media type of an MCP image block. Accepts
 * `{ data: "<base64>" }`, `{ data: "data:...;base64,..." }` and the
 * `{ image: { url } }` form some servers send.
 */
function readImageBlock(block: UnknownRecord): {
  base64: string
  mimeType: string
} {
  const mimeType =
    typeof block.mimeType === 'string' && block.mimeType.length > 0
      ? block.mimeType
      : 'image/png'

  let raw = ''
  if (typeof block.data === 'string') {
    raw = block.data
  } else if (
    block.image &&
    typeof (block.image as UnknownRecord).url === 'string'
  ) {
    raw = (block.image as UnknownRecord).url as string
  }

  const base64 =
    raw.startsWith('data:') && raw.includes(',')
      ? raw.slice(raw.indexOf(',') + 1)
      : raw
  return { base64, mimeType }
}

type HoistedImage = { mediaType: string; dataUrl: string }

export function prepareToolResultImagesForModel(
  messages: UIMessage[],
  opts: { supportsVision: boolean }
): UIMessage[] {
  const result: UIMessage[] = []

  for (const message of messages) {
    const parts = Array.isArray(message.parts) ? message.parts : []
    const hoisted: HoistedImage[] = []
    let changed = false

    const nextParts = parts.map((part) => {
      const type = (part as UnknownRecord)?.type
      if (typeof type !== 'string' || !type.startsWith('tool-')) return part

      const record = part as UnknownRecord
      const key =
        record.output !== undefined
          ? 'output'
          : record.result !== undefined
            ? 'result'
            : null
      if (!key) return part
      const output = record[key]
      if (!Array.isArray(output)) return part

      const toolName = type.slice('tool-'.length)
      let touched = false
      const nextOutput = output.map((block) => {
        if (!isImageBlock(block)) return block
        const { base64, mimeType } = readImageBlock(block)
        if (!base64) return block
        touched = true
        if (opts.supportsVision) {
          hoisted.push({
            mediaType: mimeType,
            dataUrl: `data:${mimeType};base64,${base64}`,
          })
          return {
            type: 'text',
            text: `[Image returned by tool "${toolName}", attached below.]`,
          }
        }
        return {
          type: 'text',
          text: `[Image returned by tool "${toolName}" left out to save context; this model cannot view images from tool results.]`,
        }
      })

      if (!touched) return part
      changed = true
      return { ...record, [key]: nextOutput }
    })

    result.push(
      changed ? ({ ...message, parts: nextParts } as UIMessage) : message
    )

    if (hoisted.length > 0) {
      result.push({
        id: `${message.id ?? 'msg'}_toolimg`,
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'Image result(s) from the preceding tool call(s):',
          },
          ...hoisted.map((img) => ({
            type: 'file',
            mediaType: img.mediaType,
            url: img.dataUrl,
          })),
        ],
      } as unknown as UIMessage)
    }
  }

  return result
}
