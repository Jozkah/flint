import { RemoteCallError, type RemoteClient } from '../api/client'
import type { PairingStore } from '../api/storage'
import { app } from './app'

/** Confirms the stored token with `/me`, then opens the app. */
export async function checkPairing(client: RemoteClient, store: PairingStore) {
  const pairing = store.get()
  if (!pairing) {
    app.set({ auth: 'unpaired' })
    return
  }
  app.set({ computerName: pairing.computerName ?? null })
  try {
    const me = await client.me()
    app.set({ auth: 'paired', me })
  } catch (e) {
    if (e instanceof RemoteCallError && e.code === 'unauthorized') {
      app.set({ auth: 'unpaired' })
      return
    }
    // Offline or the computer is asleep: open with what we know and let the
    // event socket reconnect.
    app.set({ auth: 'paired' })
  }
}
