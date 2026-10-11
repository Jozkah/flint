// Entry of the phone app (mobile.html). Runs in a phone's browser against the
// desktop's remote-access server, or inside the iOS shell against that
// server through the shell's pinned-TLS proxy (./shell.ts). Nothing here may
// import Tauri.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './mobile.css'
import './mobile-polish.css'
import './mobile-motion.css'
import './ios.css'
import { applyIosClass } from './platform'
import { App } from './App'
import { checkPairing } from './state/pairing'
import { RemoteClient } from './api/client'
import { EventSocket, eventsUrl } from './api/events'
import { localPairingStore, mirrorToken } from './api/storage'
import { idbSet, TOKEN_KEY } from './api/idb'
import { registerServiceWorker } from './sw/register'
import { app, handleEvent, installRuntime } from './state/app'
import { invalidate } from './state/rpc'
import { readPairingFragment } from './state/router'
import { apply as applyTheme, startTheme } from './theme'
import { getLanguage, LANGUAGE_KEY, onLanguageChange } from './i18n'
import { ConnectDesktop } from './screens/ConnectDesktop'
import {
  clearDesktop,
  connectDesktop,
  defaultDesktop,
  forgetPin,
  savedDesktop,
  saveDesktop,
  shellInvoke,
  shellLog,
  splitAddress,
} from './shell'

applyIosClass()
applyTheme()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
const root = createRoot(document.getElementById('root')!)

/** A thrown error at startup would otherwise leave a blank screen. */
function showFatal(message: string) {
  shellLog('error', message.slice(0, 2000))
  const el = document.getElementById('root')
  if (!el || el.querySelector('[data-testid="fatal"]')) return
  const box = document.createElement('pre')
  box.dataset.testid = 'fatal'
  box.style.cssText = 'white-space:pre-wrap;padding:24px;font:13px ui-monospace,monospace;color:#c00'
  box.textContent = `Flint could not start.${String.fromCharCode(10)}${message}`
  el.replaceChildren(box)
}
window.addEventListener('error', (e) => showFatal(String(e.error?.stack ?? e.message)))
window.addEventListener('unhandledrejection', (e) => showFatal(String(e.reason?.stack ?? e.reason)))

type Choice = { kind: 'connect' | 'forget'; value: string }

/** In the iOS shell: pick the desktop and bring up the pinned proxy, returning
 * the proxy's base URL. In a browser the desktop serves this page itself, so
 * there is no base. */
async function resolveBase(): Promise<string> {
  const invoke = shellInvoke()
  if (!invoke) return ''
  let error: string | null = null
  let pinChanged = false
  let attempt: string | null = savedDesktop() ?? (await defaultDesktop(invoke))
  let lastAddress = attempt ?? ''
  let fragment = ''
  for (;;) {
    if (attempt) {
      const address = attempt
      attempt = null
      try {
        const connected = await connectDesktop(invoke, address)
        saveDesktop(address)
        if (fragment) history.replaceState(null, '', fragment)
        return connected.base
      } catch (e) {
        error = String(e instanceof Error ? e.message : e)
        pinChanged = /pinned/i.test(error)
        lastAddress = address
        clearDesktop()
      }
    }
    const choice = await new Promise<Choice>((resolve) => {
      shellLog('info', 'boot: showing the connect screen')
      root.render(
        <StrictMode>
          <ConnectDesktop
            initial={lastAddress}
            error={error}
            pinChanged={pinChanged}
            onConnect={(value) => resolve({ kind: 'connect', value })}
            onForgetPin={() => resolve({ kind: 'forget', value: lastAddress })}
          />
        </StrictMode>
      )
    })
    if (choice.kind === 'forget') {
      await forgetPin(invoke, choice.value)
      attempt = choice.value
      continue
    }
    const split = splitAddress(choice.value)
    fragment = split.fragment
    attempt = split.address
    lastAddress = split.address
  }
}

async function boot() {
  shellLog('info', 'boot: start')
  const base = await resolveBase()
  shellLog('info', `boot: connected ${base || '(browser)'}`)
  const store = mirrorToken(localPairingStore(), (t) => idbSet(TOKEN_KEY, t))
  const client = new RemoteClient({ store, base })
  const socket = new EventSocket({
    url: base ? eventsUrl({ protocol: 'http:', host: base.replace(/^https?:\/\//, '') }) : undefined,
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
  // Push needs a service worker under the desktop's origin; the shell has none.
  if (!base) void registerServiceWorker()
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

  root.render(
    <StrictMode>
      <App client={client} store={store} />
    </StrictMode>
  )
}

void boot().catch((e) => showFatal(String(e?.stack ?? e)))
