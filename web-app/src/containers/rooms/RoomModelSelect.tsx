/* eslint-disable react-refresh/only-export-components */
import type { RoomModelRef } from '@/lib/rooms/types'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isProviderUsable } from '@/lib/providerReadiness'
import { offersModels } from '@/lib/providerOffers'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getProviderTitle } from '@/lib/utils'
import { PickerDropdown, type PickerGroup } from './PickerDropdown'
import { ModelAvatar } from '@/containers/ModelAvatar'

type ProviderLike = Pick<ModelProvider, 'provider' | 'models'> &
  Partial<Pick<ModelProvider, 'api_key' | 'api_key_fallbacks'>>

export function findModel(
  providers: ProviderLike[],
  ref: RoomModelRef | null | undefined
): Model | undefined {
  if (!ref) return undefined
  return providers
    .find((p) => p.provider === ref.provider)
    ?.models.find((m) => m.id === ref.id)
}

export const modelSupportsTools = (model: Model | undefined) =>
  Boolean(model?.capabilities?.includes('tools'))

const encode = (ref: RoomModelRef) => JSON.stringify([ref.provider, ref.id])
const decode = (value: string): RoomModelRef | null => {
  try {
    const [provider, id] = JSON.parse(value) as [string, string]
    return typeof provider === 'string' && typeof id === 'string' ? { provider, id } : null
  } catch {
    return null
  }
}

const modelLabel = (m: Model) => m.displayName || m.name || m.id

export const selectClassName =
  'border-border hover:border-border-strong h-8 pointer-coarse:h-11 w-full min-w-0 cursor-pointer rounded-lg border-[0.8px] bg-card px-2 text-[0.8125rem] text-foreground outline-hidden transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-ring/20 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive'

type RoomModelSelectProps = {
  id: string
  value: RoomModelRef | null
  onChange: (ref: RoomModelRef) => void
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
}

/**
 * Provider and model picker for rooms. Lists chat-capable models from every
 * provider in the store; a value that no longer resolves stays visible and is
 * marked missing instead of silently switching to another model.
 */
export function RoomModelSelect({
  id,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
}: RoomModelSelectProps) {
  const { t } = useTranslation()
  const providers = useModelProvider((s) => s.providers)
  // The same set of models the Home/Cowork model bar offers: active providers
  // that `offersModels` would surface, with embedding models excluded. Shared
  // so the Rooms picker cannot drift from the rest of the app.
  const groups = providers
    .filter((p) => p.active && offersModels(p))
    .map((p) => ({
      provider: p,
      models: p.models.filter((m) => !m.embedding),
    }))
    .filter((g) => g.models.length > 0)

  const missing = value && !findModel(providers, value)

  // The same model is often offered by several providers (a local engine and
  // two remote endpoints serving one name). The group label only shows while
  // the list is open, and a closed select shows just the option, so an
  // ambiguous name carries its provider in the option itself.
  const labelCounts = new Map<string, number>()
  for (const g of groups) {
    for (const m of g.models) {
      labelCounts.set(modelLabel(m), (labelCounts.get(modelLabel(m)) ?? 0) + 1)
    }
  }
  const optionLabel = (m: Model, provider: string) =>
    (labelCounts.get(modelLabel(m)) ?? 0) > 1
      ? `${modelLabel(m)} — ${provider}`
      : modelLabel(m)

  const pickerGroups: PickerGroup[] = [
    ...(missing && value
      ? [
          {
            items: [
              {
                value: encode(value),
                label: t('rooms:model.missing', { model: `${value.provider} / ${value.id}` }),
              },
            ],
          },
        ]
      : []),
    ...groups.map(({ provider, models }) => ({
      label: isProviderUsable(provider)
        ? getProviderTitle(provider.provider)
        : t('rooms:model.notConfigured', { provider: getProviderTitle(provider.provider) }),
      items: models.map((m) => ({
        value: encode({ provider: provider.provider, id: m.id }),
        label: optionLabel(m, provider.provider),
        hint: getProviderTitle(provider.provider),
        icon: (
          <ModelAvatar
            modelId={m.id}
            name={modelLabel(m)}
            provider={provider.provider}
            size={18}
          />
        ),
      })),
    })),
  ]

  return (
    <PickerDropdown
      id={id}
      value={value ? encode(value) : null}
      groups={pickerGroups}
      placeholder={groups.length === 0 ? t('rooms:model.noProviders') : t('rooms:model.placeholder')}
      searchPlaceholder={t('rooms:model.search')}
      disabled={disabled}
      invalid={invalid}
      describedBy={describedBy}
      onChange={(v) => {
        const ref = decode(v)
        if (ref) onChange(ref)
      }}
    />
  )
}
