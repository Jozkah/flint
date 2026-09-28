import { useEffect } from 'react'
import { Shell } from './shell/Shell'
import { Pairing, Unpaired } from './screens/Pairing'
import { FlintMark } from './ui/bits'
import type { RemoteClient } from './api/client'
import type { PairingStore } from './api/storage'
import { app, socket, syncRouteFromHash, useApp } from './state/app'
import { clearRpcCache } from './state/rpc'
import { readPairingFragment } from './state/router'
import { checkPairing } from './state/pairing'

export function App({ client, store }: { client: RemoteClient; store: PairingStore }) {
  const auth = useApp((s) => s.auth)
  const pairing = useApp((s) => s.pairing)

  useEffect(() => {
    const onHash = () => {
      const p = readPairingFragment(location.hash)
      if (p) app.set({ auth: 'pairing', pairing: p })
      else syncRouteFromHash()
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', onHash)
    }
  }, [])

  // The event socket runs while paired; coming back to the foreground
  // reconnects at once instead of waiting out the backoff.
  useEffect(() => {
    const s = socket()
    if (auth !== 'paired' || !s) return
    s.start()
    const wake = () => document.visibilityState === 'visible' && s.kick()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      s.stop()
    }
  }, [auth])

  if (auth === 'pairing' && pairing) {
    return (
      <Pairing
        code={pairing.code}
        computer={pairing.computer}
        client={client}
        store={store}
        onPaired={() => {
          clearRpcCache()
          app.set({ pairing: null, auth: 'checking', route: { name: 'home' } })
          void checkPairing(client, store)
        }}
      />
    )
  }
  if (auth === 'unpaired') return <Unpaired />
  if (auth === 'checking') {
    return (
      <div className="app">
        <div className="splash" role="status">
          <FlintMark />
          <span className="muted">Connecting to your computer…</span>
        </div>
      </div>
    )
  }
  return <Shell />
}
