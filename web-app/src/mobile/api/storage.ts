// Where the phone keeps its pairing with the computer.
//
// The device token is kept in localStorage. Tradeoff: any script running on
// this origin can read it, and it survives until the phone is unpaired or the
// site data is cleared. The alternatives are worse here: an HttpOnly cookie
// would need the server to set it and would then ride along on every request
// (CSRF surface on a LAN service), and sessionStorage is wiped whenever iOS
// evicts an installed PWA, which would force re-pairing constantly. We limit
// the exposure instead: the page loads scripts only from its own origin
// (CSP in the built page), renders no third-party content, never puts the
// token in a URL, and the desktop can revoke it at any time (Settings >
// Remote access), after which it is useless.

export const PAIRING_KEY = 'flint-remote'

export type Pairing = {
  token: string
  deviceId: string
  deviceName: string
  /** The computer's name as the pairing link gave it, when it did. */
  computerName?: string
  /** Unix ms. */
  pairedAt: number
}

export type PairingStore = {
  get(): Pairing | null
  set(p: Pairing): void
  clear(): void
}

function isPairing(v: unknown): v is Pairing {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return typeof p.token === 'string' && p.token.length > 0 && typeof p.deviceId === 'string'
}

export function localPairingStore(storage: Storage | undefined = globalThis.localStorage): PairingStore {
  return {
    get() {
      try {
        const raw = storage?.getItem(PAIRING_KEY)
        const v: unknown = raw ? JSON.parse(raw) : null
        return isPairing(v) ? v : null
      } catch {
        return null
      }
    },
    set(p) {
      try {
        storage?.setItem(PAIRING_KEY, JSON.stringify(p))
      } catch {
        // Private mode or a full quota: the pairing lasts for this visit only.
      }
    },
    clear() {
      try {
        storage?.removeItem(PAIRING_KEY)
      } catch {
        // Nothing stored.
      }
    },
  }
}

/** A store in memory, for tests and when storage is unavailable. */
export function memoryPairingStore(initial: Pairing | null = null): PairingStore {
  let value = initial
  return {
    get: () => value,
    set: (p) => {
      value = p
    },
    clear: () => {
      value = null
    },
  }
}
