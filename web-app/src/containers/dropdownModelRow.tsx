import { cn, getModelDisplayName } from '@/lib/utils'
import { middleTruncate, modelNameTail } from '@/lib/modelDisplayName'
import type {
  buildDisambiguation,
  makeRemoteLabeler,
  SearchableModel,
} from '@/lib/modelPickerItems'
import { MiddleText } from '@/components/ui/middle-text'
import Capabilities from './Capabilities'
import { ModelAvatar } from '@/containers/ModelAvatar'
import { ModelEvidenceBadges } from '@/containers/ModelEvidenceBadges'
import type { useTranslation } from '@/i18n/react-i18next-compat'
import { OFFLINE_ROW_CLASS } from '@/lib/modelAvailability'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OfflineBadge } from '@/containers/dropdownModelParts'

/** What a model picker row reads from the picker (`DropdownModelProvider`). */
type RowContext = {
  selectedModel: Model | null
  selectedProvider: string
  disambiguation: ReturnType<typeof buildDisambiguation>
  modelIsOffline: (item: SearchableModel) => boolean
  ambiguousModelIds: Set<string>
  remoteLabel: ReturnType<typeof makeRemoteLabeler>
  t: ReturnType<typeof useTranslation>['t']
  handleSelect: (searchableModel: SearchableModel) => Promise<void>
}

/** Rows are selectable with Enter or Space, not only with a pointer. */
const selectableRow = (
  item: SearchableModel,
  isSelected: boolean,
  handleSelect: RowContext['handleSelect']
) => ({
  role: 'button' as const,
  'data-model-row': '',
  tabIndex: 0,
  'aria-pressed': isSelected,
  onClick: () => handleSelect(item),
  onKeyDown: (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleSelect(item)
    }
  },
})

/**
 * One model: its mark, its name over its identifier, what is known about it
 * here, and what it can do. The same row in every list, so a model looks
 * the same whether it is a favourite, in a provider's section or in the
 * single sorted list.
 */
export function renderModelPickerRow(
  item: SearchableModel,
  list: 'fav' | 'flat' | 'group',
  {
    selectedModel,
    selectedProvider,
    disambiguation,
    modelIsOffline,
    ambiguousModelIds,
    remoteLabel,
    t,
    handleSelect,
  }: RowContext
) {
  const isSelected =
    selectedModel?.id === item.model.id &&
    selectedProvider === item.provider.provider
  const capabilities = item.model.capabilities || []
  const modelName = getModelDisplayName(item.model)
  const disambiguator = disambiguation.get(item.value)
  const offline = modelIsOffline(item)
  // A single list has no provider header, so the row carries the provider.
  // So does any row that could be mistaken for another remote's copy of the
  // same model, and every favourite (pinned above the provider sections).
  const showRemote =
    list === 'flat' ||
    list === 'fav' ||
    ambiguousModelIds.has(item.model.id)
  const secondary = showRemote
    ? `${remoteLabel(item.provider)}${modelName !== item.model.id ? ` · ${item.model.id}` : ''}`
    : modelName !== item.model.id
      ? item.model.id
      : undefined
  return (
    <div
      key={`${list}-${item.value}`}
      {...selectableRow(item, isSelected, handleSelect)}
      aria-label={secondary ? `${modelName}, ${secondary}` : modelName}
      className={cn(
        'group/mrow flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-[background-color,transform] duration-150 motion-safe:animate-mi-in motion-safe:active:scale-[.985]',
        'hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
        offline && OFFLINE_ROW_CLASS,
        isSelected && 'bg-accent'
      )}
    >
      <ModelAvatar
        modelId={item.model.id}
        name={modelName}
        provider={item.provider.provider}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="min-w-0 flex-1">
            <span className="flex items-center text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
              <MiddleText
                text={modelName}
                tail={modelNameTail(modelName)}
                data-testid="model-row-name"
              />
              {disambiguator && (
                <span
                  className="ml-1.5 shrink-0 rounded bg-muted px-1 font-mono text-[length:calc(var(--ui-font-base)*0.65625)] font-normal text-muted-foreground"
                  data-testid="model-disambiguator"
                >
                  {disambiguator.label}
                </span>
              )}
              {offline && (
                <OfflineBadge
                  label={t('common:modelOffline.badge')}
                  tooltip={t('common:modelOffline.tooltip')}
                />
              )}
            </span>
            {secondary && (
              <span
                className={cn(
                  'block truncate text-subtle-foreground',
                  list === 'flat' ? 'text-[length:calc(var(--ui-font-base)*0.6875)]' : 'font-mono text-[length:calc(var(--ui-font-base)*0.6875)]'
                )}
              >
                {middleTruncate(secondary, 44)}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {item.model.id} · {remoteLabel(item.provider)}
        </TooltipContent>
      </Tooltip>
      <ModelEvidenceBadges
        provider={item.provider.provider}
        model={item.model}
      />
      {capabilities.length > 0 && (
        <span className="ml-1 shrink-0">
          <Capabilities capabilities={capabilities} compact />
        </span>
      )}
    </div>
  )
}
