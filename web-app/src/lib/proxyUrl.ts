export type ProxyUrlCheck = 'ok' | 'empty' | 'invalid' | 'scheme'

/**
 * Whether a proxy address is one the backend will use. It mirrors
 * ProxySettings::parse in src-tauri/src/core/net/proxy.rs: an address without
 * `://` is read as `http://<address>`, only http and https are supported, and a
 * host is required. Used to warn, never to block typing or rewrite the value.
 */
export function validateProxyUrl(value: string): ProxyUrlCheck {
  if (value.trim() === '') return 'empty'
  if (/\s/.test(value.trim())) return 'invalid'
  const raw = value.trim()
  const hasScheme = raw.includes('://')
  let url: URL
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`)
  } catch {
    return 'invalid'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme'
  if (!url.hostname) return 'invalid'
  return 'ok'
}
