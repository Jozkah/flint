/**
 * The pictures a conversation has made, named `img_1`, `img_2`, ... so the text
 * model can point back at them (`image_view`, `image_edit`). The pixels stay in
 * the Studio gallery; this only maps a chat's short ids to gallery ids.
 *
 * Kept per thread in localStorage, so the names survive a restart. Storage can
 * be unavailable (private window, quota): then the names last for the session.
 */

export type ChatImage = {
  /** `img_1`: what the model sees and says. */
  id: string
  /** The Studio gallery id that holds the picture. */
  galleryId: string
  /** The prompt that made it, for the model's memory and an export's filename. */
  prompt: string
}

const KEY = 'flint:chat-images:'
const memory = new Map<string, ChatImage[]>()

const isImage = (v: unknown): v is ChatImage =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as ChatImage).id === 'string' &&
  typeof (v as ChatImage).galleryId === 'string'

export function listChatImages(threadId: string): ChatImage[] {
  const cached = memory.get(threadId)
  if (cached) return cached
  let loaded: ChatImage[] = []
  try {
    const raw = window.localStorage.getItem(KEY + threadId)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) loaded = parsed.filter(isImage)
  } catch {
    // Unreadable or unavailable storage: start empty.
  }
  memory.set(threadId, loaded)
  return loaded
}

/** The next free `img_N` for a thread: one past the highest already used. */
function nextNumber(images: readonly ChatImage[]): number {
  return (
    images.reduce((max, img) => {
      const n = Number(/^img_(\d+)$/.exec(img.id)?.[1])
      return Number.isInteger(n) && n > max ? n : max
    }, 0) + 1
  )
}

/** Name new gallery pictures for a thread, in order, and remember them. */
export function addChatImages(
  threadId: string,
  made: readonly { galleryId: string; prompt: string }[]
): ChatImage[] {
  const existing = listChatImages(threadId)
  let n = nextNumber(existing)
  const added = made.map((m) => ({
    id: `img_${n++}`,
    galleryId: m.galleryId,
    prompt: m.prompt,
  }))
  const all = [...existing, ...added]
  memory.set(threadId, all)
  try {
    window.localStorage.setItem(KEY + threadId, JSON.stringify(all))
  } catch {
    // Not persisted; the names still work for this session.
  }
  return added
}

/** The picture a chat means by `img_N`, or `undefined` if it never made one. */
export function findChatImage(
  threadId: string,
  id: string
): ChatImage | undefined {
  const wanted = id.trim().toLowerCase()
  return listChatImages(threadId).find((img) => img.id === wanted)
}

/** Forget a thread's pictures' names (its pictures stay in the gallery). */
export function clearChatImages(threadId: string): void {
  memory.delete(threadId)
  try {
    window.localStorage.removeItem(KEY + threadId)
  } catch {
    // Nothing to remove.
  }
}
