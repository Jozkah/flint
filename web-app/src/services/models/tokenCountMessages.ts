import { ContentType, type ThreadMessage } from '@janhq/core'
import {
  extractToolContextFromContent,
  extractToolContextFromMetadata,
} from './tokenCountToolContext'

/** A content part in the OpenAI chat shape the llama.cpp token counter takes. */
export type TokenCountContentPart = {
  type: string
  text?: string
  image_url?: { detail?: string; url?: string }
}

/**
 * Turns Flint's ThreadMessages into the OpenAI chat messages the token
 * counter takes, with tool context folded in and empty messages dropped.
 */
export function toTokenCountMessages(
  messages: ThreadMessage[]
): Array<{ role: string; content: string | TokenCountContentPart[] }> {
  return messages
    .map((message) => {
      // Handle different content types
      let content:
        | string
        | Array<{
            type: string
            text?: string
            image_url?: {
              detail?: string
              url?: string
            }
          }> = ''

      if (message.content && message.content.length > 0) {
        // Check if there are any image_url content types
        const hasImages = message.content.some(
          (content) => content.type === ContentType.Image
        )

        if (hasImages) {
          // For multimodal messages, preserve the array structure
          content = message.content.map((contentItem) => {
            if (contentItem.type === ContentType.Text) {
              return {
                type: 'text',
                text: contentItem.text?.value || '',
              }
            } else if (contentItem.type === ContentType.Image) {
              return {
                type: 'image_url',
                image_url: {
                  detail: contentItem.image_url?.detail,
                  url: contentItem.image_url?.url || '',
                },
              }
            }
            // Fallback for unknown content types
            return {
              type: contentItem.type,
              text: contentItem.text?.value,
              image_url: contentItem.image_url,
            }
          })
        } else {
          // For text-only messages, keep the string format
          const textContents = message.content
            .filter(
              (content) =>
                content.type === ContentType.Text && content.text?.value
            )
            .map((content) => content.text?.value || '')

          content = textContents.join(' ')
        }
      }

      const toolContextFromContent = extractToolContextFromContent(message)
      const toolContextFromMetadata =
        toolContextFromContent.length > 0
          ? ''
          : extractToolContextFromMetadata(message)
      const toolContext = [toolContextFromContent, toolContextFromMetadata]
        .filter((entry) => entry.length > 0)
        .join('\n\n')
      if (toolContext.length > 0) {
        if (typeof content === 'string') {
          content = content ? `${content}\n\n${toolContext}` : toolContext
        } else if (Array.isArray(content)) {
          content = [
            ...content,
            {
              type: 'text',
              text: toolContext,
            },
          ]
        }
      }

      return {
        role: message.role,
        content,
      }
    })
    .filter((msg) =>
      typeof msg.content === 'string'
        ? msg.content.trim() !== ''
        : Array.isArray(msg.content) && msg.content.length > 0
    ) // Filter out empty messages
}
