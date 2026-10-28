/**
 * Reading a dropped or picked file into a data URL.
 *
 * `FileReader` reports a failed read through `onerror` or `onabort`; a promise
 * that only listens for `onload` never settles then, and the whole intake
 * (and every file queued behind it) waits forever.
 */
export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('read failed'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onabort = () => reject(new Error('read aborted'))
    reader.readAsDataURL(file)
  })
}

type Keyed = {
  id?: string
  contentHash?: string
  type: string
  name: string
  path?: string
}

/** What identifies an attachment across the copies the store makes of it. */
export const attachmentKey = (a: Keyed): string =>
  a.id ?? a.contentHash ?? `${a.type}:${a.name}:${a.path ?? ''}`

/**
 * `current` without the attachments that were sent. A file attached after the
 * send read its list is not in `sent`, so it stays for the next message.
 */
export function withoutSent<T extends Keyed>(current: T[], sent: Keyed[]): T[] {
  const gone = new Set(sent.map(attachmentKey))
  return current.filter((a) => !gone.has(attachmentKey(a)))
}
