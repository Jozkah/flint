import { TriangleAlert } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'

/**
 * "Allow invalid certificates" for one provider's endpoint (janhq/jan#6792).
 *
 * Off by default. It exists for a server the user runs themselves, such as a
 * gateway with a self-signed certificate, and covers that provider's own
 * address only. The warning stays visible while it is on.
 */
export function ProviderTlsTrust({ provider }: { provider: ModelProvider }) {
  const { t } = useTranslation()
  const updateProvider = useModelProvider((s) => s.updateProvider)
  const allowed = provider.allow_invalid_certs === true

  return (
    <div
      className="mt-4 space-y-3 border-t border-border pt-4"
      data-testid="tls-trust"
    >
      <label className="flex items-start justify-between gap-3">
        <span className="space-y-1">
          <span className="block text-[13px] font-semibold text-foreground">
            {t('providers:tlsTrust.title')}
          </span>
          <span className="block text-sm leading-normal text-muted-foreground">
            {t('providers:tlsTrust.description')}
          </span>
        </span>
        <Switch
          data-testid="tls-trust-switch"
          aria-label={t('providers:tlsTrust.title')}
          checked={allowed}
          onCheckedChange={(checked) =>
            updateProvider(provider.provider, { allow_invalid_certs: checked })
          }
        />
      </label>
      {allowed && (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-xs text-destructive"
          data-testid="tls-trust-warning"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('providers:tlsTrust.warning')}
        </p>
      )}
    </div>
  )
}
