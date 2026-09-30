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

export function localPairingStore(storage?: Storage): PairingStore {
  let available = storage
  if (!available) {
    try {
      available = globalThis.localStorage
    } catch {
      // Some browsers deny access to localStorage itself.
    }
  }
  let temporary: Pairing | null = null
  let memoryOnly = !available
  return {
    get() {
      if (memoryOnly) return temporary
      let raw: string | null | undefined
      try {
        raw = available?.getItem(PAIRING_KEY)
      } catch {
        return temporary
      }
      try {
        const v: unknown = raw ? JSON.parse(raw) : null
        return isPairing(v) ? v : null
      } catch {
        return null
      }
    },
    set(p) {
      temporary = p
      try {
        if (!available) {
          memoryOnly = true
          return
        }
        available.setItem(PAIRING_KEY, JSON.stringify(p))
        memoryOnly = false
      } catch {
        // Private mode or a full quota: keep pairing for this visit. A
        // previous pairing may still be on disk; overwrite it best-effort so
        // it cannot come back on reload.
        memoryOnly = true
        try {
          available?.removeItem(PAIRING_KEY)
        } catch {
          try {
            available?.setItem(PAIRING_KEY, 'null')
          } catch {
            // Storage is unusable; nothing more to do.
          }
        }
      }
    },
    clear() {
      temporary = null
      memoryOnly = !available
      try {
        available?.removeItem(PAIRING_KEY)
      } catch {
        // removeItem failed, so the old token would come back on reload
        // ("forget device" undone). Overwrite it with a value get() rejects.
        memoryOnly = true
        try {
          available?.setItem(PAIRING_KEY, 'null')
        } catch {
          // Nothing more can be done; the entry stays until site data is cleared.
        }
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
