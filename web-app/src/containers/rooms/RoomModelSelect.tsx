/* eslint-disable react-refresh/only-export-components */
import type { RoomModelRef } from '@/lib/rooms/types'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isProviderUsable } from '@/lib/providerReadiness'
import { offersModels } from '@/lib/providerOffers'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

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
  'border-input h-8 pointer-coarse:h-11 w-full min-w-0 rounded-md border bg-card px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive'

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

  return (
    <select
      id={id}
      className={cn(selectClassName)}
      value={value ? encode(value) : ''}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => {
        const ref = decode(e.target.value)
        if (ref) onChange(ref)
      }}
    >
      <option value="" disabled>
        {groups.length === 0 ? t('rooms:model.noProviders') : t('rooms:model.placeholder')}
      </option>
      {missing && value && (
        <option value={encode(value)}>
          {t('rooms:model.missing', { model: `${value.provider} / ${value.id}` })}
        </option>
      )}
      {groups.map(({ provider, models }) => (
        <optgroup
          key={provider.provider}
          label={
            isProviderUsable(provider)
              ? provider.provider
              : t('rooms:model.notConfigured', { provider: provider.provider })
          }
        >
          {models.map((m) => (
            <option key={m.id} value={encode({ provider: provider.provider, id: m.id })}>
              {modelLabel(m)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
