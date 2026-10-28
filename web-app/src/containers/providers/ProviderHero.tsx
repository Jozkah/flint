import { Chip } from '@/components/ui/chip'
import { Switch } from '@/components/ui/switch'
import { ProviderStatusChip } from '@/components/ProviderStatusChip'
import { BrandMark } from '@/containers/engine/BrandMark'
import { providerLogo } from '@/lib/brandLogos'
import { providerKeyStatus, type ProviderKeyStatus } from '@/lib/providerKeyStatus'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Props = {
  provider: ModelProvider | undefined
  providerName: string
  title: string
  isEngineProvider: boolean
  apiKeyMissing: boolean
  headerKeyStatus: ProviderKeyStatus | undefined
  connectionFailed: boolean
  connectionVerified: boolean
  reachNote: string
  /** The enable switch; the page also stops loaded models when turning an engine off. */
  onActiveChange: (checked: boolean) => void
}

/** The provider page's header: logo, status chips and the enable switch. */
export function ProviderHero({
  provider,
  providerName,
  title,
  isEngineProvider,
  apiKeyMissing,
  headerKeyStatus,
  connectionFailed,
  connectionVerified,
  reachNote,
  onActiveChange,
}: Props) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-[14px] bg-muted bg-[repeating-linear-gradient(-62deg,transparent_0_10px,rgba(127,127,127,.06)_10px_10.8px)] p-4 shadow-[inset_0_0_0_0.8px_var(--border)] motion-safe:animate-rise-in">
      <div className="flex min-w-0 items-center gap-3.5">
        <BrandMark
          logo={providerLogo(providerName)}
          name={title}
          size={48}
          className="rounded-xl shadow-[0_0_0_0.8px_var(--border),0_8px_20px_-12px_rgba(0,0,0,.5)]"
        />
        <div className="min-w-0">
          <h2 className="descender-safe mb-2 truncate text-[length:calc(var(--ui-font-base)*1.375)] leading-none font-medium text-foreground">
            {title}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {provider?.active ? (
              isEngineProvider ? (
                <Chip tone="ok" live>
                  {t('engine:status.running')}
                </Chip>
              ) : apiKeyMissing || headerKeyStatus === 'missing' || headerKeyStatus === 'credentials-missing' ? (
                // The same words the provider list uses for the same state:
                // Bedrock has AWS credentials, not an API key, and a remote
                // provider with no endpoint yet is not "connected".
                <ProviderStatusChip
                  status={
                    provider.provider === 'bedrock' || headerKeyStatus === 'credentials-missing'
                      ? 'credentials-missing'
                      : 'missing'
                  }
                />
              ) : connectionFailed ? (
                <Chip tone="warn" dot>
                  {t('providers:status.failed')}
                </Chip>
              ) : (
                <Chip tone="ok" dot>
                  {connectionVerified
                    ? t('engine:status.verified')
                    : providerKeyStatus(provider) === 'keyless'
                      ? t('engine:status.keyless')
                      : t('engine:status.connected')}
                </Chip>
              )
            ) : (
              <Chip dot>{t('engine:status.off')}</Chip>
            )}
            <Chip
              data-testid="provider-reach-note"
              // A long note wraps inside the header instead of running past it.
              className="h-auto min-h-[22px] max-w-full shrink py-1 leading-tight whitespace-normal"
            >
              {reachNote}
            </Chip>
            <Chip>
              {t('engine:providers.modelsCount', {
                count: provider?.models.length ?? 0,
              })}
            </Chip>
          </div>
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs font-medium text-secondary-foreground">
        <Switch
          aria-label={t('providers:useProvider', { provider: title })}
          checked={provider?.active ?? false}
          onCheckedChange={onActiveChange}
        />
        {t('engine:provider.enabled')}
      </label>
    </div>
  )
}
