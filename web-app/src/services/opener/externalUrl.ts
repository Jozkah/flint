/** True only for http(s) and mailto urls: the schemes the app hands to the OS. */
export function isExternalUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return false
  }
  return ['http:', 'https:', 'mailto:'].includes(parsed.protocol)
}
