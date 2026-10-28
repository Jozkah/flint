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
  /** Set when the picture was deleted from the Studio gallery. */
  deleted?: boolean
}

const KEY = 'flint:chat-images:'
const memory = new Map<string, ChatImage[]>()

const isImage = (v: unknown): v is ChatImage =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as ChatImage).id === 'string' &&
  typeof (v as ChatImage).galleryId === 'string'

/** What storage holds for a thread now, or null when it holds nothing usable. */
function readStored(threadId: string): ChatImage[] | null {
  try {
    const raw = window.localStorage.getItem(KEY + threadId)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isImage) : null
  } catch {
    // Unreadable or unavailable storage.
    return null
  }
}

/**
 * The list a write builds on: storage as it is now (another window may have
 * named pictures since this one cached the list), else this session's copy.
 */
function listForWrite(threadId: string): ChatImage[] {
  return readStored(threadId) ?? listChatImages(threadId)
}

let watchingStorage = false
function watchStorage() {
  if (watchingStorage || typeof window === 'undefined') return
  watchingStorage = true
  try {
    window.addEventListener('storage', (e) => {
      if (e.key?.startsWith(KEY)) memory.delete(e.key.slice(KEY.length))
    })
  } catch {
    // No event target: writes still re-read storage.
  }
}

export function listChatImages(threadId: string): ChatImage[] {
  const cached = memory.get(threadId)
  if (cached) return cached
  const loaded = readStored(threadId) ?? []
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
  watchStorage()
  const existing = listForWrite(threadId)
  let n = nextNumber(existing)
  const added = made.map((m) => ({
    id: `img_${n++}`,
    galleryId: m.galleryId,
    prompt: m.prompt,
  }))
  persist(threadId, [...existing, ...added])
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

const persist = (threadId: string, all: ChatImage[]) => {
  memory.set(threadId, all)
  try {
    window.localStorage.setItem(KEY + threadId, JSON.stringify(all))
  } catch {
    // Not persisted; the names still work for this session.
  }
}

/** The threads whose pictures include this gallery picture. */
export function chatsUsingGalleryImage(galleryId: string): string[] {
  const threads = new Set<string>()
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(KEY)) threads.add(key.slice(KEY.length))
    }
  } catch {
    // Storage unavailable: only this session's names are known.
  }
  for (const id of memory.keys()) threads.add(id)
  return [...threads].filter((t) =>
    listForWrite(t).some((img) => img.galleryId === galleryId && !img.deleted)
  )
}

/**
 * Note that a gallery picture is gone. The name stays (so `img_N` is never
 * reused for another picture) but the tools report it as deleted.
 */
export function markGalleryImageDeleted(galleryId: string): void {
  for (const threadId of chatsUsingGalleryImage(galleryId)) {
    persist(
      threadId,
      listForWrite(threadId).map((img) =>
        img.galleryId === galleryId ? { ...img, deleted: true } : img
      )
    )
  }
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
