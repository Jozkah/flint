import { invokeCommand as invoke } from '@/lib/backend'
import { useMessageQueue } from '@/stores/message-queue-store'

/**
 * Guest links (docs/SERVE.md "Guest links"): the owner's side. The backend
 * holds the shares and the guest's waiting messages; this module only asks for
 * them. A link works only while `flint serve` is running and reachable.
 */

export type GuestShare = {
  id: string
  threadId: string
  createdMs: number
  expiresMs: number
  /** A browser has opened the link and is bound to it. */
  joined: boolean
  includeReasoning: boolean
  pending: number
}

export type GuestAttachment = {
  id: string
  name: string
  size: number
  path: string
}

export type GuestPending = {
  shareId: string
  threadId: string
  id: string
  /** Cleaned by the backend; untrusted text from the guest. */
  text: string
  attachments: GuestAttachment[]
  createdMs: number
}

export type GuestCreated = {
  share: GuestShare
  /** Shown once: the backend keeps only a hash. */
  token: string
  path: string
  /** Set when the server knows the name it is reached by. */
  url?: string
}

/** Choices for how long a link lasts, in hours. 7 days is the ceiling. */
export const TTL_CHOICES = [1, 6, 24, 72, 168] as const

export type GuestApi = {
  getEnabled: () => Promise<boolean>
  setEnabled: (enabled: boolean) => Promise<boolean>
  create: (
    threadId: string,
    options?: { ttlHours?: number; includeReasoning?: boolean }
  ) => Promise<GuestCreated>
  list: (threadId?: string) => Promise<GuestShare[]>
  stop: (shareId: string) => Promise<void>
  extend: (shareId: string, ttlHours: number) => Promise<GuestShare>
  pending: (threadId: string) => Promise<GuestPending[]>
  resolve: (
    shareId: string,
    pendingId: string,
    action: 'send' | 'dismiss'
  ) => Promise<{ text?: string }>
}

export const guestApi: GuestApi = {
  getEnabled: async () =>
    (await invoke<{ enabled: boolean }>('guest_share_settings_get')).enabled,
  setEnabled: async (enabled) =>
    (await invoke<{ enabled: boolean }>('guest_share_settings_set', { enabled }))
      .enabled,
  create: (threadId, options) =>
    invoke<GuestCreated>('guest_share_create', {
      threadId,
      ttlHours: options?.ttlHours ?? null,
      includeReasoning: options?.includeReasoning ?? false,
    }),
  list: (threadId) =>
    invoke<GuestShare[]>('guest_share_list', { threadId: threadId ?? null }),
  stop: async (shareId) => {
    await invoke('guest_share_stop', { shareId })
  },
  extend: (shareId, ttlHours) =>
    invoke<GuestShare>('guest_share_extend', { shareId, ttlHours }),
  pending: (threadId) => invoke<GuestPending[]>('guest_share_pending', { threadId }),
  resolve: (shareId, pendingId, action) =>
    invoke<{ text?: string }>('guest_share_resolve', {
      shareId,
      pendingId,
      action,
    }),
}

/**
 * The address to give the guest: the server's own full URL when it sent one,
 * else this page's origin when the page is served by `flint serve`, else just
 * the path (a desktop app does not know where the server is reached from).
 */
export function guestLinkUrl(
  created: Pick<GuestCreated, 'url' | 'path'>,
  origin?: string | null
): { link: string; complete: boolean } {
  if (created.url) return { link: created.url, complete: true }
  if (origin) return { link: `${origin.replace(/\/+$/, '')}${created.path}`, complete: true }
  return { link: created.path, complete: false }
}

/** The listed choice nearest to the time a share has left. */
export function nearestTtl(expiresMs: number, now: number): number {
  const hours = Math.max(0, (expiresMs - now) / 3_600_000)
  return TTL_CHOICES.reduce((best, c) =>
    Math.abs(c - hours) < Math.abs(best - hours) ? c : best
  )
}

/**
 * Sends a waiting guest message: the backend hands back the text wrapped as
 * untrusted guest input, and it goes into the thread's own queue, so it runs as
 * an ordinary user turn once the thread is idle. Nothing here runs it on its
 * own: this is only called from the owner's Send button.
 */
export async function sendGuestMessage(
  pending: GuestPending,
  api: Pick<GuestApi, 'resolve'> = guestApi,
  enqueue: (threadId: string, text: string, id: string) => void = (threadId, text, id) =>
    useMessageQueue.getState().enqueue(threadId, {
      id,
      text,
      createdAt: Date.now(),
    })
): Promise<void> {
  const { text } = await api.resolve(pending.shareId, pending.id, 'send')
  if (!text) throw new Error('the server returned no text')
  enqueue(pending.threadId, text, `guest-${pending.id}`)
}

export async function dismissGuestMessage(
  pending: GuestPending,
  api: Pick<GuestApi, 'resolve'> = guestApi
): Promise<void> {
  await api.resolve(pending.shareId, pending.id, 'dismiss')
}
