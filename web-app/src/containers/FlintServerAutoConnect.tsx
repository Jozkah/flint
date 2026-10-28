import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { isPlatformAndroid, isPlatformIOS } from '@/lib/platform/utils'
import {
  autoConnectSkipped,
  loadServerConfig,
  skipAutoConnect,
} from '@/lib/flintServer'

const SECONDS = 4

/**
 * On a phone build with a saved Flint server and "Open at start" on, say that
 * the server is about to open and give a way out. Choosing this device sets a
 * flag for the session, so coming back from the server does not start the
 * countdown again.
 */
export function FlintServerAutoConnect() {
  const mobile = isPlatformAndroid() || isPlatformIOS()
  const [target] = useState(() => {
    if (!mobile || autoConnectSkipped()) return null
    const saved = loadServerConfig()
    return saved?.autoConnect ? saved.url : null
  })
  const [left, setLeft] = useState(SECONDS)
  const [cancelled, setCancelled] = useState(false)
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const cancel = () => {
    skipAutoConnect()
    setCancelled(true)
  }

  // Escape stays on this device; the button gets focus so the way out is
  // one keypress away for keyboard and screen reader users.
  useEffect(() => {
    if (!target || cancelled) return
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [target, cancelled])

  useEffect(() => {
    if (!target || cancelled) return
    if (left <= 0) {
      window.location.assign(target)
      return
    }
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [target, cancelled, left])

  if (!target || cancelled) return null
  let host = target
  try {
    host = new URL(target).host
  } catch {
    // Show the address as saved.
  }
  return (
    <div
      role="status"
      data-testid="flint-server-autoconnect"
      className="fixed inset-x-3 bottom-3 z-50 flex items-center gap-3 rounded-xl border bg-card p-3 text-sm shadow-lg"
    >
      {/* Announced once; the ticking number below is visual only. */}
      <span className="sr-only">{t('server:openingNotice', { host })}</span>
      <span className="min-w-0 flex-1 truncate" aria-hidden="true">
        {t('server:opening', { host, seconds: left })}
      </span>
      <Button ref={cancelRef} variant="outline" size="sm" onClick={cancel}>
        {t('server:useDevice')}
      </Button>
    </div>
  )
}
