// Entry of the phone app (mobile.html). Runs in a phone's browser against the
// desktop's remote-access server; nothing here may import Tauri.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './mobile.css'
import './mobile-polish.css'
import './mobile-motion.css'
import { App } from './App'
import { checkPairing } from './state/pairing'
import { RemoteClient } from './api/client'
import { EventSocket } from './api/events'
import { localPairingStore, mirrorToken } from './api/storage'
import { idbSet, TOKEN_KEY } from './api/idb'
import { registerServiceWorker } from './sw/register'
import { app, handleEvent, installRuntime } from './state/app'
import { invalidate } from './state/rpc'
import { readPairingFragment } from './state/router'
import { startTheme } from './theme'
import { getLanguage, LANGUAGE_KEY, onLanguageChange } from './i18n'

const store = mirrorToken(localPairingStore(), (t) => idbSet(TOKEN_KEY, t))
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
const syncHidden = () => socket.setHidden(document.visibilityState === 'hidden')
document.addEventListener('visibilitychange', syncHidden)
syncHidden()
void registerServiceWorker()
startTheme()
// The page's language, for the service worker's notifications (no localStorage there).
document.documentElement.lang = getLanguage()
void idbSet(LANGUAGE_KEY, getLanguage())
onLanguageChange((language) => {
  document.documentElement.lang = language
  void idbSet(LANGUAGE_KEY, language)
})

const pairing = readPairingFragment(location.hash)
if (pairing) app.set({ auth: 'pairing', pairing })
else void checkPairing(client, store)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={client} store={store} />
  </StrictMode>
)
