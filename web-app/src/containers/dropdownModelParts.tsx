import { cn, isLocalProvider } from '@/lib/utils'
import { classifyModelLocation } from '@/lib/modelLocation'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { OFFLINE_DOT_CLASS } from '@/lib/modelAvailability'

/**
 * "This provider just failed to answer."
 *
 * Not a probe result: it appears only after a real request to the endpoint
 * failed at the transport layer, and it goes as soon as one succeeds. An
 * installed local model that is merely unloaded never lands here.
 */
export const OfflineBadge = ({ label, tooltip }: { label: string; tooltip: string }) => (
  <span
    className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/30 px-1.5 py-0.5 text-[length:calc(var(--ui-font-base)*0.625)] font-medium text-destructive"
    title={tooltip}
  >
    <span className={cn('size-1.5 rounded-full', OFFLINE_DOT_CLASS)} aria-hidden />
    {label}
  </span>
)

/**
 * Where a provider's requests are processed. Stated on the section header so
 * choosing a model also says whether messages leave this device.
 */
export const ProcessingLocationLabel = ({ provider }: { provider: ModelProvider }) => {
  const { t } = useTranslation()
  const location = classifyModelLocation({
    baseUrl: provider.base_url,
    builtInEngine: Boolean(isLocalProvider(provider.provider)),
  })
  if (location !== 'local' && location !== 'remote') return null
  const text = t(`model-fit:location.${location}`)
  return (
    <span className="truncate text-[length:calc(var(--ui-font-base)*0.625)] text-muted-foreground" title={text}>
      · {text}
    </span>
  )
}
