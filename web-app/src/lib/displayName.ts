import { truncateMiddle } from '@/lib/attachmentChip'

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
}

/**
 * The name a person should see for a file reference: `name.ext`, never the
 * `file:///C:/Users/...` URL or the directory it lives in. Percent-escapes in
 * URLs are decoded, query/fragment of a URL are dropped, drive letters, UNC
 * shares and directories are stripped. Display only: the full value stays in a
 * tooltip and in what is sent to the model.
 *
 * `max` middle-truncates (extension kept).
 */
export function displayNameOf(urlOrPath: string, max?: number): string {
  let value = (urlOrPath ?? '').trim()
  if (!value) return ''

  let out: string
  const data = /^data:([^;,]*)/i.exec(value)
  if (data) {
    const ext = MIME_EXT[data[1].toLowerCase()]
    out = ext
      ? `${data[1].toLowerCase().startsWith('image/') ? 'image' : 'file'}.${ext}`
      : 'file'
  } else if (/^blob:/i.test(value)) {
    out = 'file'
  } else {
    const isUrl = /^[a-z][a-z0-9+.-]+:\/\//i.test(value)
    if (isUrl) {
      value = value.replace(/[?#][\s\S]*$/, '')
      try {
        value = decodeURIComponent(value)
      } catch {
        // malformed escape: show it as written
      }
    }
    const last = value.split(/[\\/]/).filter(Boolean).pop() ?? ''
    // `file:///C:/` leaves a bare drive letter or scheme: nothing to show.
    out = /^[a-z][a-z0-9+.-]*:$/i.test(last) ? '' : last
    if (!out) out = value
  }
  return max ? truncateMiddle(out, max) : out
}

/** Lower-case extension of the display name, empty when there is none. */
export function extensionOf(name: string): string {
  const base = displayNameOf(name)
  const dot = base.lastIndexOf('.')
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : ''
}
