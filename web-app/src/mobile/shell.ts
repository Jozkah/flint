// The Tauri iOS shell. The page is bundled in the app, so unlike the browser
// client there is no desktop origin to be same-origin with: the app's Rust side
// (core/thin_client.rs) runs a loopback proxy that talks pinned TLS to the
// desktop, and the client is pointed at that proxy's base URL.
//
// Only the invoke bridge is touched, never an import of @tauri-apps, so the
// browser build stays free of Tauri.

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

export type Connected = {
  base: string
  host: string
  port: number
  fingerprint: string
  firstUse: boolean
}

const KEY = 'flint.desktop'

export function shellInvoke(win: Window = window): Invoke | null {
  const internals = (win as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } })
    .__TAURI_INTERNALS__
  const invoke = internals?.invoke
  return typeof invoke === 'function' ? (cmd, args) => invoke.call(internals, cmd, args) : null
}

export function savedDesktop(storage: Pick<Storage, 'getItem'> = localStorage): string | null {
  try {
    return storage.getItem(KEY)
  } catch {
    return null
  }
}

export function saveDesktop(address: string, storage: Pick<Storage, 'setItem'> = localStorage) {
  try {
    storage.setItem(KEY, address)
  } catch {
    // Private mode: the address is asked for again next launch.
  }
}

export function clearDesktop(storage: Pick<Storage, 'removeItem'> = localStorage) {
  try {
    storage.removeItem(KEY)
  } catch {
    // Nothing stored.
  }
}

/** `https://host:port` for an address or a pairing link, and the `#pair=...`
 * fragment the link carried (the client's pairing screen reads it). */
export function splitAddress(input: string): { address: string; fragment: string } {
  const text = input.trim()
  const hash = text.indexOf('#')
  const fragment = hash >= 0 ? text.slice(hash) : ''
  const beforeHash = hash >= 0 ? text.slice(0, hash) : text
  const withScheme = /^https?:\/\//i.test(beforeHash) ? beforeHash : `https://${beforeHash}`
  try {
    const url = new URL(withScheme)
    return { address: `https://${url.host}`, fragment }
  } catch {
    return { address: withScheme, fragment }
  }
}

export async function connectDesktop(invoke: Invoke, address: string): Promise<Connected> {
  return (await invoke('thin_client_connect', { url: address })) as Connected
}

export async function forgetPin(invoke: Invoke, address: string): Promise<void> {
  await invoke('thin_client_forget', { url: address })
}

/** Reports to the app log from the shell; a no-op in a browser. */
export function shellLog(level: 'info' | 'warn' | 'error', message: string) {
  try {
    void shellInvoke()?.('thin_client_log', { level, message })
  } catch {
    // The log is best effort.
  }
}
