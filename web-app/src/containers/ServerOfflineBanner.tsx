import { useEffect } from 'react'
import { WifiOff } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { startServerConnectionMonitor, useServerConnection } from '@/lib/serverConnection'

/**
 * The browser client's notice that the server it came from is not answering.
 * Mounted only on a page `flint serve` serves; it watches the connection and
 * goes away by itself once the server answers again.
 */
export function ServerOfflineBanner() {
  const { t } = useTranslation()
  const offline = useServerConnection((s) => s.state === 'offline')
  useEffect(() => startServerConnectionMonitor(), [])
  if (!offline) return null
  return (
    <div
      role="alert"
      data-testid="server-offline-banner"
      className="mx-auto mt-2 flex w-full max-w-3xl items-start gap-2 rounded-lg border border-warning/35 bg-warning-tint px-3 py-2 text-sm text-warning"
    >
      <WifiOff aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">
        <b className="font-medium">{t('common:serverConnection.offlineTitle')}</b>{' '}
        <span>{t('common:serverConnection.offlineBody')}</span>
      </span>
    </div>
  )
}
