import { useMemo } from 'react'
import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn, getProviderTitle } from '@/lib/utils'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  MAX_NOTE_CHARS,
  useModelRouting,
  type ModelRoutingMode,
} from '@/hooks/useModelRouting'

const MODES: ModelRoutingMode[] = ['off', 'ask', 'auto']
const LOCAL_PROVIDERS = new Set(['llamacpp', 'mlx'])

/**
 * Settings for Jev choosing the AI model: when it may (Off, Ask first, Always)
 * and the models it may choose from, each with an optional note that tells Jev
 * what that model is good for. Needs Jev's skill suggestions to be On, since
 * the same opt-in governs everything Jev is asked.
 */
export function JevModelRoutingCard() {
  const { t } = useTranslation()
  const mode = useModelRouting((s) => s.mode)
  const pool = useModelRouting((s) => s.pool)
  const skillMode = useJevSettings((s) => s.skillMode)
  const providers = useModelProvider((s) => s.providers)

  // Providers that can be used now, with their models.
  const usable = useMemo(
    () =>
      providers
        .filter(
          (p) =>
            p.active !== false &&
            (p.models?.length ?? 0) > 0 &&
            (LOCAL_PROVIDERS.has(p.provider) || providerHasRemoteApiKeys(p))
        )
        .map((p) => ({
          provider: p.provider,
          title: p.displayName || getProviderTitle(p.provider),
          models: (p.models ?? []).filter((m) => !m.embedding),
        }))
        .filter((p) => p.models.length > 0),
    [providers]
  )

  return (
    <Card title={t('common:jev.modelRoutingTitle')}>
      <CardItem
        anchor="settings-jev-model-routing"
        align="start"
        title={t('common:jev.modelRoutingMode')}
        description={
          <>
            <p>{t('common:jev.modelRoutingExplained')}</p>
            {mode !== 'off' && skillMode !== 'on' && (
              <p className="mt-1 text-warning" data-testid="model-routing-needs-jev">
                {t('common:jev.modelRoutingNeedsJev')}
              </p>
            )}
          </>
        }
        actions={
          <div
            role="radiogroup"
            aria-label={t('common:jev.modelRoutingMode')}
            data-testid="model-routing-mode"
            className="inline-flex rounded-md border border-border p-0.5"
          >
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                data-mode={m}
                onClick={() => useModelRouting.getState().setMode(m)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs',
                  mode === m ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground'
                )}
              >
                {t(`common:jev.modelRoutingModes.${m}`)}
              </button>
            ))}
          </div>
        }
      />
      {mode !== 'off' && (
        <>
          <CardItem
            align="start"
            description={<p className="text-muted-foreground">{t('common:jev.modelRoutingListHelp')}</p>}
          />
          {usable.length === 0 ? (
            <CardItem
              align="start"
              description={<p className="text-muted-foreground">{t('common:jev.modelRoutingNoModels')}</p>}
            />
          ) : (
            usable.map((p) => (
              <CardItem
                key={p.provider}
                column
                align="start"
                title={p.title}
                description={
                  <ul className="mt-1 flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
                    {p.models.map((m) => {
                      const entry = pool.find((r) => r.provider === p.provider && r.model === m.id)
                      const name = m.displayName || m.id
                      return (
                        <li key={m.id} className="flex flex-wrap items-center gap-2">
                          <Switch
                            aria-label={t('common:jev.modelRoutingInclude', { model: name })}
                            data-testid={`model-routing-${p.provider}-${m.id}`}
                            checked={Boolean(entry)}
                            onCheckedChange={(on) =>
                              useModelRouting.getState().setIncluded(p.provider, m.id, on)
                            }
                          />
                          <span className="min-w-0 flex-1 basis-40 truncate text-[13px] text-foreground" title={name}>
                            {name}
                          </span>
                          {entry && (
                            <input
                              type="text"
                              value={entry.note ?? ''}
                              maxLength={MAX_NOTE_CHARS}
                              placeholder={t('common:jev.modelRoutingNote')}
                              aria-label={t('common:jev.modelRoutingNoteFor', { model: name })}
                              onChange={(e) =>
                                useModelRouting.getState().setNote(p.provider, m.id, e.target.value)
                              }
                              className="h-8 min-w-0 flex-1 basis-56 rounded border border-border bg-card px-2 text-xs"
                            />
                          )}
                        </li>
                      )
                    })}
                  </ul>
                }
              />
            ))
          )}
        </>
      )}
    </Card>
  )
}
