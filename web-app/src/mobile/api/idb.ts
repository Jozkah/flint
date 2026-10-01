// A tiny IndexedDB key-value store the page and the service worker share.
//
// The service worker has no localStorage, so the device token is mirrored
// here for notification actions (Allow once / Deny from the lock screen).
// Tradeoff: the token now sits in two places on this origin instead of one.
// Both are readable only by scripts on this origin (the page loads none from
// elsewhere, CSP), both are wiped with the site data, and unpairing on either
// side clears both (the desktop revokes the token, after which it is useless
// wherever it is stored). Keeping it only in IndexedDB would avoid the copy,
// but the page's storage is synchronous and older code reads it at startup.

const DB = 'flint-remote'
const STORE = 'kv'

function open(idb: IDBFactory | undefined): Promise<IDBDatabase | null> {
  if (!idb) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = idb.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

const factory = (): IDBFactory | undefined => {
  try {
    return globalThis.indexedDB
  } catch {
    return undefined
  }
}

export async function idbGet<T>(key: string, idb = factory()): Promise<T | null> {
  const db = await open(idb)
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as T) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** Writes `value`, or deletes the key when it is null. Never throws. */
export async function idbSet(key: string, value: unknown, idb = factory()): Promise<void> {
  const db = await open(idb)
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      const s = tx.objectStore(STORE)
      if (value === null || value === undefined) s.delete(key)
      else s.put(value, key)
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

export const TOKEN_KEY = 'token'
