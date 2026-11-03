import { Copy, ExternalLink, Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { FadeText } from '@/components/ui/fade-text'
import { Chip } from '@/components/ui/chip'
import { MiddleText } from '@/components/ui/middle-text'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn, formatBytes, getProviderTitle } from '@/lib/utils'
import { modelLogo } from '@/lib/brandLogos'
import { missingKeyLabelKey, providerKeyStatus } from '@/lib/providerKeyStatus'
import { effectiveContextLength, formatTps } from '@/lib/engineModels'
import { CapabilityChips, TBOX_ROW } from '@/containers/engine/EngineKit'
import { BrandMark } from '@/containers/engine/BrandMark'
import { RowMenu } from '@/containers/engine/RowMenu'

type KeyStatusOptions = Parameters<typeof providerKeyStatus>[1]

/** One row of the installed-models table: logo, name, provider, capabilities, size, context, speed, status, menu. */
export function ModelsTableRow({
  provider,
  model,
  local,
  loaded,
  fileSize,
  speedAvg,
  maxSpeed,
  keyOptions,
  onStart,
  onStop,
  onOpenProvider,
}: {
  provider: ModelProvider
  model: ModelProvider['models'][number]
  local: boolean
  loaded: boolean
  /** On-disk bytes of a local model, when known. */
  fileSize?: number
  /** Average tokens per second over the recent replies, when measured. */
  speedAvg?: number
  /** The fastest average among all models: the speed bar's full width. */
  maxSpeed: number
  keyOptions: KeyStatusOptions
  onStart: () => void
  onStop: () => void
  onOpenProvider: () => void
}) {
  const { t } = useTranslation()
  const ctx = effectiveContextLength(model, provider)
  const keyStatus = providerKeyStatus(provider, keyOptions)
  const hasKey = keyStatus !== 'missing' && keyStatus !== 'credentials-missing'
  return (
    <div
      data-testid={`models-row-${model.id}`}
      className={cn(
        TBOX_ROW,
        // Phones: a two-line card (logo + name, then the
        // figures and status) instead of columns cut off.
        'max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:gap-y-1.5',
        'motion-safe:animate-rise-in'
      )}
    >
      <BrandMark
        logo={modelLogo(model.id, provider.provider)}
        name={model.name || model.id}
        size={30}
      />
      <div className="flex min-w-0 flex-col gap-0.5 max-sm:basis-[calc(100%-42px)]">
        <FadeText
          as="b"
          className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground"
          title={model.id}
        >
          {model.name || model.id}
        </FadeText>
        {/* Middle-truncated: two long ids that share a
            prefix still differ by their tail (the quant). */}
        <MiddleText
          text={model.id}
          tail={18}
          title={model.id}
          className="font-mono text-[length:calc(var(--ui-font-base)*0.6875)] text-subtle-foreground"
        />
      </div>
      <span className="min-w-0">
        {/* The provider, never the quantization: a local id's
            `:Q4_K_M` tag is already in the id under the name. */}
        <Chip className="max-w-full" data-testid="models-provider-cell">
          <span className="truncate">{getProviderTitle(provider.provider)}</span>
        </Chip>
      </span>
      {/* Always a cell, even with no capabilities, so the
          columns after it stay in place. */}
      <span className="min-w-0 overflow-hidden" data-slot="caps-cell">
        <CapabilityChips
          iconOnly
          className="flex-nowrap"
          capabilities={model.capabilities ?? []}
        />
      </span>
      <span
        className={cn(
          'min-w-0 truncate tabular-nums',
          !local && 'text-muted-foreground'
        )}
      >
        {local
          ? fileSize
            ? formatBytes(fileSize)
            : '—'
          : t('engine:table.remote')}
      </span>
      <span className="min-w-0 truncate tabular-nums">
        {ctx ? ctx.toLocaleString() : '—'}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        {speedAvg && maxSpeed > 0 ? (
          <>
            <span className="h-1.5 w-full overflow-hidden rounded-full bg-track">
              <i
                className="block h-full rounded-full bg-grad motion-safe:animate-draw-x"
                style={{ width: `${(speedAvg / maxSpeed) * 100}%` }}
              />
            </span>
            <small className="text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground tabular-nums">
              {formatTps(speedAvg)}
            </small>
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </span>
      <span className="min-w-0">
        {local ? (
          loaded ? (
            <Chip tone="ok" live>
              {t('engine:status.loaded')}
            </Chip>
          ) : (
            <Chip dot>{t('engine:status.ready')}</Chip>
          )
        ) : hasKey ? (
          <Chip tone="ok" dot>
            {keyStatus === 'keyless'
              ? t('engine:status.keyless')
              : t('engine:status.connected')}
          </Chip>
        ) : (
          <Chip tone="warn" dot>
            {t(missingKeyLabelKey(provider.provider))}
          </Chip>
        )}
      </span>
      <RowMenu
        label={t('engine:menu.modelActions', { model: model.name || model.id })}
        items={[
          ...(local
            ? [
                loaded
                  ? {
                      label: t('engine:menu.stop'),
                      icon: <Square />,
                      onSelect: onStop,
                    }
                  : {
                      label: t('engine:menu.start'),
                      icon: <Play />,
                      onSelect: onStart,
                    },
              ]
            : []),
          {
            label: t('engine:menu.openProvider'),
            icon: <ExternalLink />,
            onSelect: onOpenProvider,
          },
          {
            label: t('engine:menu.copyId'),
            icon: <Copy />,
            onSelect: () => {
              void navigator.clipboard
                ?.writeText(model.id)
                .then(() => toast.success(t('engine:menu.copied')))
                .catch(() => {})
            },
          },
        ]}
      />
    </div>
  )
}
