import { create } from 'zustand'
import { promptSlug } from '@/lib/promptLibrary'
import { createImageAttachment, type Attachment } from '@/types/attachment'
import type { MCPPromptContent, MCPPromptInfo } from '@/services/mcp/types'

/**
 * MCP prompts (prompts/list, prompts/get) in the desktop composer.
 *
 * A server's prompt is a template its author wrote, filled in with the
 * arguments the user typed. What comes back is inserted into the composer as
 * the user's own draft, to read and edit before sending -- never merged into
 * Flint's instructions, and never sent on its own.
 */

/** The `/` trigger for a server's prompt: `mcp:<server>:<prompt>`. */
export function mcpPromptTrigger(prompt: Pick<MCPPromptInfo, 'server' | 'name'>): string {
  return `mcp:${promptSlug(prompt.server)}:${promptSlug(prompt.name)}`
}

/** Arguments the server requires that are still empty. */
export function missingMcpArguments(
  prompt: MCPPromptInfo,
  values: Record<string, string>
): string[] {
  return prompt.arguments
    .filter((a) => a.required && !(values[a.name] ?? '').trim())
    .map((a) => a.name)
}

/** Only the arguments the user filled in; the server applies its own defaults. */
export function filledMcpArguments(
  values: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v.trim() !== '')
  )
}

/**
 * The composer text and image attachments for a filled-in prompt. Text
 * messages are joined in order; when the prompt has an assistant turn the
 * messages are labelled by role, so the model can still tell who said what.
 */
export function composeMcpPrompt(
  prompt: Pick<MCPPromptInfo, 'name'>,
  content: MCPPromptContent
): { text: string; images: Attachment[] } {
  const labelled = content.messages.some((m) => m.role === 'assistant')
  const texts: string[] = []
  const images: Attachment[] = []
  for (const message of content.messages) {
    if (message.text !== undefined && message.text !== '') {
      texts.push(labelled ? `[${message.role}] ${message.text}` : message.text)
    }
    if (message.image) {
      const { data, mimeType } = message.image
      const ext = mimeType.split('/')[1]?.split('+')[0] || 'png'
      images.push(
        createImageAttachment({
          name: `${promptSlug(prompt.name)}-${images.length + 1}.${ext}`,
          dataUrl: `data:${mimeType};base64,${data}`,
          mimeType,
          size: Math.floor((data.length * 3) / 4),
        })
      )
    }
  }
  return { text: texts.join('\n\n'), images }
}

type McpPromptStore = {
  prompts: MCPPromptInfo[]
  setPrompts: (prompts: MCPPromptInfo[]) => void
}

/** The prompts the running servers offer, as last listed. */
export const useMcpPrompts = create<McpPromptStore>()((set) => ({
  prompts: [],
  setPrompts: (prompts) => set({ prompts }),
}))
