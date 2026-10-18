import { useMemo } from 'react'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getProviderTitle } from '@/lib/utils'
import { ModelAvatar } from '@/containers/ModelAvatar'
import { usePickerModelMeta } from '@/hooks/usePickerModelMeta'
import { PickerDropdown, type PickerGroup } from '@/containers/rooms/PickerDropdown'

export type LocalModelRef = { model: string; provider: string }

const LOCAL_PROVIDERS = ['llamacpp', 'mlx']

const encode = (ref: LocalModelRef) => JSON.stringify([ref.provider, ref.model])
const decode = (value: string): LocalModelRef | null => {
  try {
    const [provider, model] = JSON.parse(value) as [string, string]
    return typeof provider === 'string' && typeof model === 'string'
      ? { provider, model }
      : null
  } catch {
    return null
  }
}

const modelLabel = (m: Model) => m.displayName || m.name || m.id

/**
 * The model picker of the rest of the app (search box, provider groups, the
 * avatar and a middle-truncated name per row), limited to models that run on
 * this machine. It reports the choice to `onChange` and touches no chat state.
 */
export function LocalModelSelect({
  id,
  value,
  onChange,
}: {
  id?: string
  value: LocalModelRef | null
  onChange: (ref: LocalModelRef) => void
}) {
  const { t } = useTranslation()
  const providers = useModelProvider((s) => s.providers)
  const metaOf = usePickerModelMeta()

  const groups = useMemo<PickerGroup[]>(
    () =>
      providers
        .filter((p) => LOCAL_PROVIDERS.includes(p.provider))
        .map((p) => ({
          label: getProviderTitle(p.provider),
          items: p.models
            .filter((m) => !m.embedding)
            .map((m) => ({
              value: encode({ provider: p.provider, model: m.id }),
              label: modelLabel(m),
              ...metaOf(m, p.provider),
              icon: (
                <ModelAvatar
                  modelId={m.id}
                  name={modelLabel(m)}
                  provider={p.provider}
                  size={18}
                />
              ),
            })),
        }))
        .filter((g) => g.items.length > 0),
    [providers, metaOf]
  )

  const encoded = value ? encode(value) : null
  // A saved model that was since removed stays visible by its id.
  const known = groups.some((g) => g.items.some((i) => i.value === encoded))

  return (
    <PickerDropdown
      id={id}
      value={encoded}
      groups={groups}
      shownLabel={value && !known ? value.model : undefined}
      placeholder={t('settings:localApiServer.defaultModelPlaceholder')}
      searchPlaceholder={t('rooms:model.search')}
      emptyLabel={t('settings:localApiServer.noLocalModels')}
      onChange={(v) => {
        const ref = decode(v)
        if (ref) onChange(ref)
      }}
    />
  )
}
