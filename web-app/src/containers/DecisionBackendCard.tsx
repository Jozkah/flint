import { useMemo } from 'react'
import { Segmented } from '@/components/ui/segmented'
import { Card, CardItem } from '@/containers/Card'
import { McpRouterModelPicker } from '@/containers/McpRouterModelPicker'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useModelProvider } from '@/hooks/useModelProvider'
import { classifyModelLocation } from '@/lib/modelLocation'
import { isLocalProvider } from '@/lib/utils'
import {
  DECISION_PRESETS,
  JEV_BACKEND,
  findPresetModel,
  normalizeBackend,
} from '@/lib/decisionBackends'

type Kind = 'jev' | 'open_model'

/**
 * Who answers the Jev opt-ins: TypeSafe's Jev, or an open model the user
 * already has in Flint. Only the choice is stored here; the backend resolves
 * the provider and makes (or skips) every request.
 */
export function DecisionBackendCard({ anchor }: { anchor?: string }) {
  const { t } = useTranslation()
  const backend = normalizeBackend(useJevSettings((s) => s.backend))
  const setBackend = useJevSettings((s) => s.setBackend)
  const providers = useModelProvider((s) => s.providers)

  const open = backend.kind === 'open_model' ? backend : null
  const chosen = open && open.provider && open.model ? open : null
  const location = useMemo(() => {
    if (!chosen) return null
    const p = providers.find((x) => x.provider === chosen.provider)
    return classifyModelLocation({
      baseUrl: p?.base_url,
      builtInEngine: Boolean(isLocalProvider(chosen.provider)),
    })
  }, [chosen, providers])

  const pickKind = (k: Kind) =>
    setBackend(k === 'jev' ? JEV_BACKEND : { kind: 'open_model', provider: '', model: '' })

  const pickPreset = (presetId: string) => {
    if (!presetId) {
      setBackend({ kind: 'open_model', provider: open?.provider ?? '', model: open?.model ?? '' })
      return
    }
    const found = findPresetModel(presetId, providers)
    setBackend({
      kind: 'open_model',
      provider: found?.provider ?? open?.provider ?? '',
      model: found?.model ?? open?.model ?? '',
      preset: presetId,
    })
  }

  const presetLabel = DECISION_PRESETS.find((p) => p.id === open?.preset)?.label

  return (
    <Card title={t('common:jev.backendTitle')}>
      <CardItem
        anchor={anchor}
        align="start"
        title={t('common:jev.backendLabel')}
        description={<p>{t('common:jev.backendExplained')}</p>}
        actions={
          <Segmented<Kind>
            size="sm"
            aria-label={t('common:jev.backendLabel')}
            value={backend.kind}
            onValueChange={pickKind}
            options={[
              { value: 'jev', label: t('common:jev.backendJev'), testId: 'jev-backend-jev' },
              { value: 'open_model', label: t('common:jev.backendOpen'), testId: 'jev-backend-open' },
            ]}
          />
        }
      />
      {open && (
        <CardItem
          align="start"
          title={t('common:jev.backendPreset')}
          description={
            <p>
              {open.preset && !chosen
                ? t('common:jev.backendPresetMissing', { name: presetLabel ?? open.preset })
                : t('common:jev.backendPresetExplained')}
            </p>
          }
          actions={
            <select
              data-testid="jev-backend-preset"
              aria-label={t('common:jev.backendPreset')}
              value={open.preset ?? ''}
              onChange={(e) => pickPreset(e.target.value)}
              className="h-8 rounded border border-border bg-card px-2 text-xs"
            >
              <option value="">{t('common:jev.backendPresetCustom')}</option>
              {DECISION_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          }
        />
      )}
      {open && (
        <CardItem
          align="start"
          title={t('common:jev.backendModel')}
          description={
            <p data-testid="jev-backend-where">
              {!chosen
                ? t('common:jev.backendNoModel')
                : location === 'local'
                  ? t('common:jev.backendLocal')
                  : t('common:jev.backendRemote', { provider: chosen.provider })}
            </p>
          }
          actions={
            <McpRouterModelPicker
              ariaLabel={t('common:jev.backendModel')}
              providers={providers}
              selectedProvider={open.provider}
              selectedModelId={open.model}
              onSelect={(provider, model) =>
                setBackend({ kind: 'open_model', provider, model, ...(open.preset ? { preset: open.preset } : {}) })
              }
              placeholder={t('common:jev.backendModelPlaceholder')}
              searchPlaceholder={t('common:jev.backendModelSearch')}
              emptyListMessage={t('common:jev.backendModelEmpty')}
              formatEmptySearch={(q) => t('common:jev.backendModelEmptySearch', { query: q })}
            />
          }
        />
      )}
    </Card>
  )
}
