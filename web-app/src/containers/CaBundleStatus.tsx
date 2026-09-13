import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/**
 * What a custom certificate authority bundle does right now (AH-190), as the
 * backend's `network_ca_check` reports it. Kept apart from the settings page so
 * each state -- nothing configured, in use, broken -- can be shown and tested
 * without the page around it.
 */
export type CaBundleState =
  | { state: 'none' }
  | { state: 'in_use'; path: string; certificates: number; sha256: string[] }
  | { state: 'broken'; kind: string; path: string; message: string }

export function CaBundleStatus({ status }: { status: CaBundleState | null }) {
  const { t } = useTranslation()
  if (!status || status.state === 'none') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="ca-bundle-status-none">
        {t('settings:httpsProxy.caBundleNone')}
      </p>
    )
  }
  if (status.state === 'in_use') {
    return (
      <div className="space-y-1" data-testid="ca-bundle-status-in-use">
        <p className="text-xs text-success">
          {t('settings:httpsProxy.caBundleInUse', { count: status.certificates })}
        </p>
        <ul className="text-[11px] font-mono text-muted-foreground break-all">
          {status.sha256.map((fingerprint) => (
            <li key={fingerprint}>SHA-256 {fingerprint}</li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div className="space-y-1" data-testid="ca-bundle-status-broken">
      <p className={cn('text-xs text-destructive')}>
        {t('settings:httpsProxy.caBundleBroken', { kind: status.kind })}
      </p>
      <p className="text-xs text-muted-foreground break-all">{status.message}</p>
    </div>
  )
}
