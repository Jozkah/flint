// Files waiting in a phone composer: uploaded to the computer as soon as
// they are picked (chunked, /remote/v1/upload), sent by id with the message.
// Keyed by composer: `new` (Home), `chat:<id>`, `cowork:<id>`.

import { createStore } from './store'
import { client, toast } from './app'
import { downscaleImage } from '../ui/downscale'
import { RemoteCallError } from '../api/client'
import { t } from '../i18n'

export type PhoneAttachment = {
  localId: string
  name: string
  size: number
  mime: string
  status: 'uploading' | 'ready' | 'error'
  progress: number
  uploadId?: string
  error?: string
  /** Object URL of a picked image, for its chip. */
  preview?: string
  /** A file on the computer, referenced by its path in the session folder. */
  desk?: string
}

export const attachments = createStore<{
  by: Record<string, PhoneAttachment[]>
  /** Text to put into a composer at its cursor (an @ reference); `n` changes per request. */
  insert: { key: string; text: string; n: number } | null
}>({ by: {}, insert: null })

let inserts = 0
/** Puts `text` into the composer `key` (at the cursor, spaced from what is there). */
export function insertIntoComposer(key: string, text: string) {
  attachments.set({ insert: { key, text, n: ++inserts } })
}

export const attachKey = (target: { for: 'home' | 'chat' | 'cowork'; id?: string }) =>
  target.for === 'home' || !target.id ? 'new' : `${target.for}:${target.id}`

let seq = 0
const patch = (key: string, localId: string, p: Partial<PhoneAttachment>) =>
  attachments.set((s) => ({
    by: { ...s.by, [key]: (s.by[key] ?? []).map((a) => (a.localId === localId ? { ...a, ...p } : a)) },
  }))

/** Most files on one message, as on the desktop. */
export const MAX_FILES = 10

export async function addFiles(key: string, files: File[]): Promise<void> {
  const room = MAX_FILES - (attachments.get().by[key]?.length ?? 0)
  if (files.length > room) toast(t('attachments.max', { count: MAX_FILES }))
  await Promise.all(
    files.slice(0, Math.max(0, room)).map(async (raw) => {
      const localId = `a${Date.now().toString(36)}${(seq++).toString(36)}`
      const isImage = raw.type.startsWith('image/')
      const item: PhoneAttachment = {
        localId,
        name: raw.name || t('attachments.file'),
        size: raw.size,
        mime: raw.type,
        status: 'uploading',
        progress: 0,
        ...(isImage && typeof URL.createObjectURL === 'function' ? { preview: URL.createObjectURL(raw) } : {}),
      }
      attachments.set((s) => ({ by: { ...s.by, [key]: [...(s.by[key] ?? []), item] } }))
      try {
        const file = isImage ? await downscaleImage(raw) : raw
        patch(key, localId, { size: file.size, name: file.name })
        const info = await client().upload(file, (f) => patch(key, localId, { progress: f }))
        patch(key, localId, { status: 'ready', progress: 1, uploadId: info.uploadId, mime: info.mime, name: info.name })
      } catch (e) {
        const msg = e instanceof RemoteCallError ? e.message : t('attachments.uploadFailed')
        patch(key, localId, { status: 'error', error: msg })
        toast(`${raw.name}: ${msg}`)
      }
    })
  )
}

export function addDeskFile(key: string, path: string) {
  const list = attachments.get().by[key] ?? []
  if (list.some((a) => a.desk === path)) return
  const name = path.split('/').pop() || path
  const item: PhoneAttachment = { localId: `d${(seq++).toString(36)}`, name, size: 0, mime: '', status: 'ready', progress: 1, desk: path }
  attachments.set((s) => ({ by: { ...s.by, [key]: [...list, item] } }))
}

export function removeAttachment(key: string, localId: string) {
  const a = attachments.get().by[key]?.find((x) => x.localId === localId)
  if (!a) return
  if (a.preview) URL.revokeObjectURL?.(a.preview)
  if (a.uploadId) void client().cancelUpload(a.uploadId)
  attachments.set((s) => ({ by: { ...s.by, [key]: (s.by[key] ?? []).filter((x) => x.localId !== localId) } }))
}

export function clearAttachments(key: string) {
  for (const a of attachments.get().by[key] ?? []) if (a.preview) URL.revokeObjectURL?.(a.preview)
  attachments.set((s) => {
    const by = { ...s.by }
    delete by[key]
    return { by }
  })
}

/** `@path` references for files on the computer. */
export const deskRefs = (list: readonly PhoneAttachment[]) => list.filter((a) => a.desk).map((a) => `@${a.desk}`)

/** What a send carries, or why it must wait. */
export function outgoing(key: string): { ok: true; uploadIds: string[]; refs: string[]; any: boolean } | { ok: false; why: string } {
  const list = attachments.get().by[key] ?? []
  if (list.some((a) => a.status === 'uploading')) return { ok: false, why: t('attachments.wait') }
  const ready = list.filter((a) => a.status === 'ready')
  return {
    ok: true,
    uploadIds: ready.filter((a) => a.uploadId).map((a) => a.uploadId!),
    refs: deskRefs(ready),
    any: ready.length > 0,
  }
}
