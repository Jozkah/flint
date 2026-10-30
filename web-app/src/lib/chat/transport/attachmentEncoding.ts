import type { UIMessage } from '@ai-sdk/react'
import { encodeAudioSentinel, parseAudioDataUrl } from '@/lib/audio-sentinel'
import { encodeVideoSentinel, parseVideoDataUrl } from '@/lib/video-sentinel'

// Attachment mappers for the chat transport. Moved out of
// `CustomChatTransport` unchanged; the class methods delegate here.

// Replace audio `file` parts on user messages with sentinel-bearing `text`
// parts. The `@ai-sdk/openai-compatible` provider rejects non-image file
// parts in its converter; the matching fetch wrapper in model-factory.ts
// decodes these sentinels back into OpenAI `input_audio` content parts on
// the outgoing wire, which llama-server's chat-completions endpoint accepts.
export function encodeAudioAttachments(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.parts)) return message
    let touched = false
    const nextParts = message.parts.map((part) => {
      if (
        part?.type === 'file' &&
        typeof (part as { mediaType?: string }).mediaType === 'string' &&
        (part as { mediaType: string }).mediaType.startsWith('audio/') &&
        typeof (part as { url?: string }).url === 'string'
      ) {
        const parsed = parseAudioDataUrl((part as { url: string }).url)
        if (!parsed) return part
        touched = true
        return { type: 'text' as const, text: encodeAudioSentinel(parsed.format, parsed.data) }
      }
      return part
    })
    if (!touched) return message
    return { ...message, parts: nextParts } as UIMessage
  })
}

// Replace video `file` parts on user messages with sentinel-bearing `text`
// parts, same mechanism as encodeAudioAttachments. The fetch wrapper in
// model-factory.ts decodes these into llama-server `input_video` content
// parts (frames decoded via the vision encoder + ffmpeg on the server).
export function encodeVideoAttachments(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.parts)) return message
    let touched = false
    const nextParts = message.parts.map((part) => {
      if (
        part?.type === 'file' &&
        typeof (part as { mediaType?: string }).mediaType === 'string' &&
        (part as { mediaType: string }).mediaType.startsWith('video/') &&
        typeof (part as { url?: string }).url === 'string'
      ) {
        const parsed = parseVideoDataUrl((part as { url: string }).url)
        if (!parsed) return part
        touched = true
        return { type: 'text' as const, text: encodeVideoSentinel(parsed.data) }
      }
      return part
    })
    if (!touched) return message
    return { ...message, parts: nextParts } as UIMessage
  })
}

export function mapUserInlineAttachments(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      const metadata = message.metadata as
        | {
            inline_file_contents?: Array<{ name?: string; content?: string }>
          }
        | undefined
      const inlineFileContents = Array.isArray(metadata?.inline_file_contents)
        ? metadata.inline_file_contents.filter((f) => f?.content)
        : []
      // Tool messages have content as array of ToolResultPart
      if (inlineFileContents.length > 0) {
        const buildInlineText = (base: string) => {
          if (!inlineFileContents.length) return base
          const formatted = inlineFileContents
            .map((f) => `File: ${f.name || 'attachment'}\n${f.content ?? ''}`)
            .join('\n\n')
          return base ? `${base}\n\n${formatted}` : formatted
        }

        if (message.parts.length > 0) {
          // Return a fresh message with fresh text parts rather than
          // overwriting `message.parts` in place. Mutating the input would
          // both leak into the persisted transcript and, on a second mapping
          // of the same array, append the inline content a second time
          // (jan#9022). Non-text parts and metadata are carried over by
          // reference without being touched.
          // Once, on the last text part: a message split into several text
          // parts sent every file once per part.
          let lastText = -1
          message.parts.forEach((part, i) => {
            if (part.type === 'text') lastText = i
          })
          const parts = message.parts.map((part, i) => {
            if (part.type === 'text' && i === lastText) {
              return {
                type: 'text' as const,
                text: buildInlineText(part.text ?? ''),
              }
            }
            return part
          })
          return { ...message, parts }
        }
      }
    }

    return message
  })
}
