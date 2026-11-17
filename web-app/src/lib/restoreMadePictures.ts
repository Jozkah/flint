import { useEffect, useMemo, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { findChatImage } from '@/lib/chatImages'
import { studioApi } from '@/lib/studio/studio'
import type { ToolImage } from '@/lib/toolOutputImages'

/**
 * A saved Cowork session keeps no pixels (`stripSessionToolImages`), but an
 * `image_gen` / `image_edit` result still says which pictures it made
 * (`"images":["img_1"]`), and the Studio gallery still holds them. These
 * helpers read those names back and fetch the pictures, so a reopened session
 * shows them again without the base64 ever being saved with it.
 */

const MADE_TOOLS = new Set(['image_gen', 'image_edit'])

type Rec = Record<string, unknown>

/** The `img_N` names a saved made-picture result lists, in order. */
export function savedPictureNames(output: unknown): string[] {
  if (typeof output !== 'string') return []
  const list = /"images"\s*:\s*\[([^\]]*)\]/.exec(output)?.[1]
  if (!list) return []
  return [...list.matchAll(/"(img_\d+)"/g)].map((m) => m[1])
}

/** Fetch the named pictures from the gallery; a missing or deleted one is skipped. */
export async function loadMadePictures(
  threadId: string,
  names: readonly string[]
): Promise<ToolImage[]> {
  const out: ToolImage[] = []
  for (const name of names) {
    const found = findChatImage(threadId, name)
    if (!found || found.deleted) continue
    try {
      out.push({
        dataUrl: await studioApi.media('image', found.galleryId),
        name: `${name}.png`,
      })
    } catch {
      // The picture is gone from disk: the card keeps its text.
    }
  }
  return out
}

const madeToolPart = (part: unknown): Rec | null => {
  const p = part as Rec
  if (typeof p?.type !== 'string' || !p.type.startsWith('tool-')) return null
  if (!MADE_TOOLS.has(p.type.slice('tool-'.length))) return null
  if (p.state !== 'output-available' || p.toolImages) return null
  return p
}

/** Messages with `toolImages` filled in from `restored`, keyed by tool call id. */
export function withRestoredPictures(
  messages: UIMessage[],
  restored: ReadonlyMap<string, ToolImage[]>
): UIMessage[] {
  if (restored.size === 0) return messages
  return messages.map((m) => {
    let changed = false
    const parts = (Array.isArray(m.parts) ? m.parts : []).map((part) => {
      const p = madeToolPart(part)
      const images = p && restored.get(String(p.toolCallId))
      if (!p || !images?.length) return part
      changed = true
      return { ...p, toolImages: images } as unknown as typeof part
    })
    return changed ? ({ ...m, parts } as UIMessage) : m
  })
}

/** `messages`, with the pictures a reopened session lost brought back. */
export function useRestoredMadePictures(
  messages: UIMessage[],
  sessionId: string | undefined
): UIMessage[] {
  const [restored, setRestored] = useState<Map<string, ToolImage[]>>(
    () => new Map()
  )
  useEffect(() => {
    if (!sessionId) return
    let live = true
    const todo: Array<[string, string[]]> = []
    for (const m of messages) {
      for (const part of Array.isArray(m.parts) ? m.parts : []) {
        const p = madeToolPart(part)
        if (!p || restored.has(String(p.toolCallId))) continue
        const names = savedPictureNames(p.output)
        if (names.length) todo.push([String(p.toolCallId), names])
      }
    }
    if (todo.length === 0) return
    void (async () => {
      const found = new Map<string, ToolImage[]>()
      for (const [id, names] of todo) {
        // An empty list is kept too, so a vanished picture is not asked for again.
        found.set(id, await loadMadePictures(sessionId, names))
      }
      if (live) setRestored((prev) => new Map([...prev, ...found]))
    })()
    return () => {
      live = false
    }
  }, [messages, sessionId, restored])
  return useMemo(
    () => withRestoredPictures(messages, restored),
    [messages, restored]
  )
}
