// Entry of the phone app (mobile.html). Runs in a phone's browser against the
// desktop's remote-access server; nothing here may import Tauri.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './mobile.css'
import { App } from './App'
import { checkPairing } from './state/pairing'
import { RemoteClient } from './api/client'
import { EventSocket } from './api/events'
import { localPairingStore } from './api/storage'
import { app, handleEvent, installRuntime } from './state/app'
import { invalidate } from './state/rpc'
import { readPairingFragment } from './state/router'
import { startTheme } from './theme'

const store = localPairingStore()
const client = new RemoteClient({ store })
const socket = new EventSocket({
  token: () => store.get()?.token ?? null,
  onEvent: handleEvent,
  onState: (conn) => {
    const was = app.get().conn
    app.set({ conn })
    // Back online: whatever was shown may be out of date.
    if (conn === 'connected' && was !== 'connected') invalidate([''])
  },
  onUnauthorized: () => {
    store.clear()
    app.set({ auth: 'unpaired' })
  },
  onLagged: () => invalidate(['']),
  probe: async () => {
    try {
      await client.me()
      return true
    } catch (e) {
      return !(e && typeof e === 'object' && 'code' in e && e.code === 'unauthorized')
    }
  },
})
client.setUnauthorizedHandler(() => app.set({ auth: 'unpaired' }))
installRuntime({ client, socket })
startTheme()

const pairing = readPairingFragment(location.hash)
if (pairing) app.set({ auth: 'pairing', pairing })
else void checkPairing(client, store)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={client} store={store} />
  </StrictMode>
)
