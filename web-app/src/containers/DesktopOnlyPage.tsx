import { MonitorSmartphone } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * What a page shows in the browser served by `flint serve` when everything on
 * it works only in the desktop app: one plain line instead of controls that
 * would fail.
 */
export function DesktopOnlyPage({ title }: { title: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col gap-2 px-4 py-10 text-center" data-testid="desktop-only-page">
      <MonitorSmartphone className="mx-auto size-8 text-muted-foreground" aria-hidden />
      <h1 className="text-lg font-medium text-foreground">{title}</h1>
      <p className="text-sm text-muted-foreground">{t('permissions:desktopOnly')}</p>
    </div>
  )
}
