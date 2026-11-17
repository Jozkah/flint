import { imagesOfOutput } from '@/lib/toolOutputImages'
import type { MessagePartLike } from './types'

/** Tools whose pictures are the point of the turn, so the message shows them. */
const MADE_PICTURE_TOOLS = new Set(['image_gen', 'image_edit'])

export const isMadePictureTool = (toolName: string | undefined): boolean =>
  !!toolName && MADE_PICTURE_TOOLS.has(toolName)

const toolNameOf = (part: MessagePartLike): string =>
  part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : ''

/**
 * The pictures a trace's `image_gen` / `image_edit` calls made, in order, for
 * the message to show under the folded steps. Empty while a call is running
 * or when it failed.
 */
export function madePictures(
  parts: readonly MessagePartLike[]
): ReturnType<typeof imagesOfOutput> {
  const out: ReturnType<typeof imagesOfOutput> = []
  for (const part of parts) {
    if (!isMadePictureTool(toolNameOf(part))) continue
    if (part.state !== 'output-available') continue
    out.push(...(part.toolImages ?? imagesOfOutput(part.output)))
  }
  return out
}
