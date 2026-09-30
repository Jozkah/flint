/**
 * `open_in_browser`: the model shows the user a web page.
 *
 * Only http and https, so the tool cannot be turned into a way to launch a
 * file or a custom-protocol handler. A page on this computer opens at once --
 * that is a dev server the user asked to see. Any other site is shown as a
 * card and the user presses Open: a model that can navigate the user's browser
 * unprompted to arbitrary sites is not something to allow silently.
 */
import { getServiceHub } from '@/hooks/useServiceHub'

export type BrowserTarget = {
  url: string
  /** `host[:port]`, for the card's second line. */
  origin: string
  /** Path and query worth showing after the origin, without the slash alone. */
  path: string
  title?: string
  /** On this computer: opened without asking. */
  local: boolean
}

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.+\.localhost)$/

export function parseBrowserTarget(input: unknown): BrowserTarget | null {
  if (!input || typeof input !== 'object') return null
  const { url, title } = input as { url?: unknown; title?: unknown }
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  const path = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`
  return {
    url: parsed.href,
    origin: parsed.host,
    path,
    title: typeof title === 'string' && title.trim() ? title.trim() : undefined,
    local: LOCAL.test(parsed.hostname),
  }
}

export const openInBrowser = (url: string): Promise<void> =>
  getServiceHub().opener().openUrl(url)

/** What the model is told. Opened, or waiting for the user to press Open. */
export async function runOpenInBrowser(
  input: unknown
): Promise<{ content: string } | { error: string }> {
  const target = parseBrowserTarget(input)
  if (!target) {
    return {
      error:
        'open_in_browser needs an http:// or https:// url without a username or password.',
    }
  }
  if (!target.local) {
    return {
      content: JSON.stringify({
        status: 'shown',
        url: target.url,
        message:
          'Shown to the user with an Open button; it is not opened until they press it.',
      }),
    }
  }
  try {
    await openInBrowser(target.url)
  } catch (e) {
    return { error: `Could not open the browser: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { content: JSON.stringify({ status: 'opened', url: target.url }) }
}
