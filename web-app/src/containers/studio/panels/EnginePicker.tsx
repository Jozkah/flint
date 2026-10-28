import { useState } from 'react'
import { Check, ChevronsUpDown, Search, Settings, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ModelAvatar } from '@/containers/ModelAvatar'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/**
 * The engine for a picture, in the same popover the chat's model picker uses:
 * a search box, models on this computer first, then hosted ones grouped by
 * provider, then the two ways to get more.
 */
export function EnginePicker({
  value,
  label,
  providerId,
  modelId,
  local,
  hosted,
  disabled,
  onLocal,
  onHosted,
}: {
  value: string
  label: string
  /** The hosted provider in use, for the mark beside the name. */
  providerId?: string
  modelId: string
  local: Array<{ id: string; name: string }>
  hosted: Array<{ key: string; name: string; provider: string; providerId: string }>
  disabled?: boolean
  onLocal: (id: string) => void
  onHosted: (key: string) => void
}) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const localShown = local.filter((m) => !q || m.name.toLowerCase().includes(q))
  const hostedShown = hosted.filter(
    (m) => !q || `${m.name} ${m.provider}`.toLowerCase().includes(q)
  )
  const providers = [...new Set(hostedShown.map((m) => m.providerId))]
  const heading =
    'px-2 pt-2.5 pb-1 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-wide text-subtle-foreground uppercase'
  const row = (selected: boolean) =>
    cn(
      'flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
      selected && 'bg-accent'
    )
  const pick = (fn: () => void) => {
    fn()
    setOpen(false)
    setSearch('')
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={t('studio:picker.engine')}
          className="-ml-1 flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        >
          <ModelAvatar modelId={modelId} name={label} provider={providerId} />
          <span className="min-w-0 flex-1 truncate text-[length:calc(var(--ui-font-base)*0.9375)] font-semibold text-foreground">
            {label}
          </span>
          <ChevronsUpDown className="size-[13px] shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[min(26rem,calc(100vh-16px))] w-[360px] max-w-[calc(100vw-24px)] overflow-hidden p-1.5"
      >
        <div className="flex max-h-[inherit] flex-col">
          <div className="flex items-center gap-2 border-b border-dashed border-border px-2 pt-1.5 pb-2">
            <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('studio:picker.searchPlaceholder')}
              aria-label={t('studio:picker.searchAria')}
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-base font-normal text-foreground outline-0 placeholder:text-muted-foreground md:text-[length:calc(var(--ui-font-base)*0.8125)]"
            />
            {search && (
              <button
                type="button"
                aria-label={t('studio:picker.clear')}
                onClick={() => setSearch('')}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-1 [scrollbar-width:thin]">
            {localShown.length === 0 && hostedShown.length === 0 && (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('studio:picker.noMatch')}</p>
            )}
            {localShown.length > 0 && (
              <div>
                <p className={heading}>{t('studio:picker.local')}</p>
                {localShown.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={row(value === `local:${m.id}`)}
                    onClick={() => pick(() => onLocal(m.id))}
                  >
                    <ModelAvatar modelId={m.id} name={m.name} />
                    <span className="min-w-0 flex-1 truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                      {m.name}
                    </span>
                    {value === `local:${m.id}` && <Check className="size-3.5 text-muted-foreground" aria-hidden />}
                  </button>
                ))}
              </div>
            )}
            {providers.map((id) => {
              const models = hostedShown.filter((m) => m.providerId === id)
              return (
                <div key={id}>
                  <div className="flex items-center gap-1.5 px-2 pt-2.5 pb-0.5 text-xs">
                    <span className="shrink-0 [&_[data-slot=brand-mark]]:!size-3.5">
                      <ProvidersAvatar provider={{ provider: id } as ProviderObject} />
                    </span>
                    <span className="font-semibold text-foreground">{models[0].provider}</span>
                    <span className="text-[length:calc(var(--ui-font-base)*0.6875)] text-subtle-foreground">· {t('studio:picker.leaves')}</span>
                  </div>
                  {models.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      className={row(value === `cloud:${m.key}`)}
                      onClick={() => pick(() => onHosted(m.key))}
                    >
                      <ModelAvatar modelId={m.name} name={m.name} provider={m.providerId} />
                      <span className="min-w-0 flex-1 truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                        {m.name}
                      </span>
                      {value === `cloud:${m.key}` && <Check className="size-3.5 text-muted-foreground" aria-hidden />}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="mt-1.5 flex shrink-0 flex-col border-t border-dashed border-border pt-1">
            <button
              type="button"
              className={row(false)}
              onClick={() => pick(() => navigate({ to: route.hub.index }))}
            >
              <Search className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="text-[length:calc(var(--ui-font-base)*0.8125)] text-secondary-foreground">{t('studio:picker.findMore')}</span>
            </button>
            <button
              type="button"
              className={row(false)}
              onClick={() => pick(() => navigate({ to: route.settings.model_providers }))}
            >
              <Settings className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="text-[length:calc(var(--ui-font-base)*0.8125)] text-secondary-foreground">
                {hosted.length ? t('studio:picker.manageHosted') : t('studio:picker.addKey')}
              </span>
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
