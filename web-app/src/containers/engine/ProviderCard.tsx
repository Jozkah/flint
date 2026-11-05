import { FadeText } from '@/components/ui/fade-text'
import { Switch } from '@/components/ui/switch'
import { Chip } from '@/components/ui/chip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ProviderStatusChip } from '@/components/ProviderStatusChip'
import { providerKeyStatus } from '@/lib/providerKeyStatus'
import { useBedrockCredentials } from '@/hooks/useBedrockCredentials'
import { BrandMark } from '@/containers/engine/BrandMark'
import { ProviderCardMenu } from '@/containers/engine/ProviderCardMenu'
import { providerLogo } from '@/lib/brandLogos'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { isEngineProviderName } from '@/lib/engineModels'
import { cn, getProviderTitle } from '@/lib/utils'

/** One provider tile on the Providers and models tab. */
export function ProviderCard({
  provider,
  menuOpen,
  onMenuOpenChange,
  onOpenMenu,
  onOpenProvider,
  onToggle,
  onRename,
  onRemove,
}: {
  provider: ProviderObject
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  onOpenMenu: () => void
  onOpenProvider: () => void
  onToggle: (active: boolean) => void
  onRename: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const bedrockCredentials = useBedrockCredentials((state) => state.saved)
  const title = getProviderTitle(provider.provider)
  const local = isEngineProviderName(provider.provider)
  const setUp =
    local || provider.models.length > 0 || providerHasRemoteApiKeys(provider)
  return (
    <li
      key={provider.provider}
      data-testid={`provider-row-${provider.provider}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onOpenMenu()
      }}
      onKeyDown={(e) => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault()
          onOpenMenu()
        }
      }}
      className={cn(
        'group relative flex flex-col items-start gap-1.5 rounded-xl border-[0.8px] border-border p-3 text-left transition-[transform,box-shadow] duration-300 ease-expo motion-safe:animate-rise-in',
        provider.active
          ? 'bg-card hover:-translate-y-0.5 hover:shadow-lift'
          : 'bg-muted'
      )}
    >
      <div className="mb-1 flex w-full items-start justify-between">
        <BrandMark
          logo={providerLogo(provider.provider)}
          name={title}
          size={40}
          className={cn(!provider.active && 'opacity-60')}
        />
        <div className="flex items-center gap-1">
          <ProviderCardMenu
            provider={provider}
            title={title}
            open={menuOpen}
            onOpenChange={onMenuOpenChange}
            onEdit={onOpenProvider}
            onToggle={() => onToggle(!provider.active)}
            onRename={onRename}
            onRemove={onRemove}
          />
          <Switch
            className="relative z-10"
            checked={provider.active}
            aria-label={t('providers:useProvider', {
              provider: title,
            })}
            onCheckedChange={(e) => onToggle(e)}
          />
        </div>
      </div>
      {provider.active ? (
        <button
          type="button"
          onClick={onOpenProvider}
          aria-label={t('providers:openProvider', { provider: title })}
          className="min-w-0 max-w-full text-left text-[length:calc(var(--ui-font-base)*0.84375)] font-semibold text-foreground outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40"
        >
          <FadeText>{title}</FadeText>
        </button>
      ) : (
        <FadeText as="b" className="max-w-full text-[length:calc(var(--ui-font-base)*0.84375)] font-semibold text-foreground opacity-60">
          {title}
        </FadeText>
      )}
      <small className="text-xs text-muted-foreground">
        {local ? t('engine:providers.onDevice') : t('engine:providers.remote')}
        {' · '}
        {setUp
          ? t('engine:providers.modelsCount', { count: provider.models.length })
          : t('engine:providers.notSetUp')}
      </small>
      {provider.active ? (
        <ProviderStatusChip
          status={providerKeyStatus(provider, { bedrockCredentials })}
        />
      ) : (
        <Chip dot>{t('engine:status.off')}</Chip>
      )}
    </li>
  )
}
