// Registers the service worker (Web Push). Push needs a secure context: the
// Tailscale certificate or a certificate the user installed. A self-signed
// LAN certificate the browser was only told to accept does not count.

export const SW_URL = '/m/sw.js'

export async function registerServiceWorker(nav: Navigator | undefined = globalThis.navigator): Promise<ServiceWorkerRegistration | null> {
  if (!nav || !('serviceWorker' in nav) || !globalThis.isSecureContext) return null
  try {
    return await nav.serviceWorker.register(SW_URL, { scope: '/m/' })
  } catch {
    return null
  }
}
