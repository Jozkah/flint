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
