import type { UIMessage } from '@ai-sdk/react'

/**
 * Images a built-in tool returned for the model to see (Cowork's `read` of a
 * png/jpg/gif/webp file).
 *
 * In a run's message history the tool part's `output` becomes an MCP-style block
 * list, `[{ type: 'text', text }, { type: 'image', data: <data URL>, ... }]`.
 * `prepareToolResultImagesForModel` already turns that shape into a proper image
 * part for a model that can see, or a short note for one that cannot, so the
 * request path needs nothing new.
 *
 * Everything else that touches those messages must NOT treat the data URL as
 * text: this file is where the rest of the app learns what an image costs and
 * how to drop one.
 */

export type ToolImage = { dataUrl: string; name: string }

/** What one image is counted as, whatever the length of its base64. */
export const IMAGE_TOKEN_COST = 1200

/** Same cost expressed as text, for estimators that count characters. */
export const IMAGE_ESTIMATE_TEXT = 'i'.repeat(Math.round(IMAGE_TOKEN_COST * 3.5))

export const AGENT_IMAGE_ORIGIN = 'agent-tools'

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object'

export const isImageBlock = (b: unknown): boolean =>
  isRec(b) && b.type === 'image'

const mimeOfDataUrl = (url: string): string =>
  /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/png'

/** Tool output text plus its images, as one history entry. */
export function toolOutputWithImages(
  text: string,
  images: readonly ToolImage[] | undefined
): string | unknown[] {
  if (!images || images.length === 0) return text
  return [
    { type: 'text', text },
    ...images.map((img) => ({
      type: 'image',
      data: img.dataUrl,
      mimeType: mimeOfDataUrl(img.dataUrl),
      name: img.name,
      // Marks an image Flint's own tools returned, so a request that would
      // otherwise leave tool results alone still attaches it for the model.
      origin: AGENT_IMAGE_ORIGIN,
    })),
  ]
}

/** How many images a tool output carries. */
export function countOutputImages(output: unknown): number {
  return Array.isArray(output) ? output.filter(isImageBlock).length : 0
}

function placeholder(block: Rec): string {
  const name =
    typeof block.name === 'string' && block.name ? ` ${block.name}` : ''
  return `[image${name}]`
}

/**
 * The output as text: its text blocks, and a short marker where an image was.
 * The base64 is never part of this.
 */
export function outputTextWithoutImages(output: unknown): string {
  if (!Array.isArray(output)) {
    return typeof output === 'string' ? output : JSON.stringify(output ?? '')
  }
  return output
    .map((b) => {
      if (isImageBlock(b)) return placeholder(b as Rec)
      if (isRec(b) && b.type === 'text' && typeof b.text === 'string')
        return b.text
      return typeof b === 'string' ? b : JSON.stringify(b)
    })
    .join('\n')
}

/** Characters this output counts as: its text, plus a fixed cost per image. */
export function outputEstimateChars(output: unknown): number {
  return outputForEstimate(output).length
}

/**
 * `output` for a text estimator: the text, with an image counted as a fixed
 * modest amount instead of the length of its base64.
 */
export function outputForEstimate(output: unknown): string {
  const images = countOutputImages(output)
  if (!Array.isArray(output) || images === 0) {
    return typeof output === 'string' ? output : JSON.stringify(output ?? '')
  }
  return (
    JSON.stringify(output.filter((b) => !isImageBlock(b))) +
    IMAGE_ESTIMATE_TEXT.repeat(images)
  )
}

const SAVED_NOTE = '\n[The image itself is not kept in the saved session.]'

/** A tool output as it is saved: an image becomes a note, text is untouched. */
export function outputForStorage(output: unknown): unknown {
  if (countOutputImages(output) === 0) return output
  return outputTextWithoutImages(output) + SAVED_NOTE
}

/** Whether any tool result here carries an image Flint's own tools returned. */
export function hasAgentToolImages(messages: readonly UIMessage[]): boolean {
  return messages.some((m) =>
    (Array.isArray(m.parts) ? m.parts : []).some((p) => {
      const out = (p as unknown as Rec)?.output
      return (
        Array.isArray(out) &&
        out.some(
          (b) => isImageBlock(b) && (b as Rec).origin === AGENT_IMAGE_ORIGIN
        )
      )
    })
  )
}

/** The images in a tool output, for a thumbnail. */
export function imagesOfOutput(output: unknown): ToolImage[] {
  if (!Array.isArray(output)) return []
  return output.filter(isImageBlock).flatMap((b) => {
    const r = b as Rec
    if (typeof r.data !== 'string' || !r.data) return []
    const mime = typeof r.mimeType === 'string' ? r.mimeType : 'image/png'
    return [
      {
        dataUrl: r.data.startsWith('data:')
          ? r.data
          : `data:${mime};base64,${r.data}`,
        name: typeof r.name === 'string' ? r.name : 'image',
      },
    ]
  })
}

/**
 * The copy of a history that is stored: every image in a tool output is
 * replaced by a one-line note, so a session on disk never holds the base64 and
 * a resumed run is not handed an image it cannot account for. Messages without
 * images are returned as the same objects.
 */
export function stripToolOutputImages(messages: UIMessage[]): UIMessage[] {
  let any = false
  const out = messages.map((message) => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    let changed = false
    const next = parts.map((part) => {
      const record = part as unknown as Rec
      if (
        typeof record?.type !== 'string' ||
        !(record.type === 'dynamic-tool' || record.type.startsWith('tool-')) ||
        countOutputImages(record.output) === 0
      ) {
        return part
      }
      changed = true
      return {
        ...record,
        output: outputForStorage(record.output),
      } as unknown as typeof part
    })
    if (!changed) return message
    any = true
    return { ...message, parts: next } as UIMessage
  })
  return any ? out : messages
}

type WithToolImages = { toolImages?: unknown }

function stripTurnImages<T extends WithToolImages>(
  turns: T[] | undefined
): T[] | undefined {
  if (!turns || !turns.some((t) => t && t.toolImages !== undefined)) return turns
  return turns.map((t) => {
    if (!t || t.toolImages === undefined) return t
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { toolImages: _dropped, ...rest } = t
    return rest as T
  })
}

/**
 * What of a Cowork session is written to disk: its history without the images
 * tool results carried, and its turns without their display thumbnails. The
 * text of every result stays. Returns the same object when nothing needed
 * dropping, so a store can map every session on each write cheaply.
 */
export function stripSessionToolImages<
  S extends {
    messages?: UIMessage[]
    turns?: WithToolImages[]
    inFlight?: { turns?: WithToolImages[] }
  },
>(session: S): S {
  const messages = session.messages
    ? stripToolOutputImages(session.messages)
    : session.messages
  const turns = stripTurnImages(session.turns)
  const inFlightTurns = session.inFlight
    ? stripTurnImages(session.inFlight.turns)
    : undefined
  if (
    messages === session.messages &&
    turns === session.turns &&
    inFlightTurns === session.inFlight?.turns
  ) {
    return session
  }
  return {
    ...session,
    ...(messages !== session.messages ? { messages } : {}),
    ...(turns !== session.turns ? { turns } : {}),
    ...(inFlightTurns !== session.inFlight?.turns && session.inFlight
      ? { inFlight: { ...session.inFlight, turns: inFlightTurns } }
      : {}),
  }
}
