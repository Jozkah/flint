import { Funnel } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  activeFilterCount,
  isFiltered,
  type PickerCapability,
  type PickerFacets,
  type PickerFilterState,
  type PickerSort,
  type PickerSource,
} from '@/lib/pickerFilters'

/** The funnel beside the search box, in the look of the composer's filter button. */
export function PickerFilterButton({
  state,
  open,
  onToggle,
}: {
  state: PickerFilterState
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const count = activeFilterCount(state)
  return (
    <button
      type="button"
      aria-label={t('common:picker.filter')}
      title={t('common:picker.filter')}
      aria-expanded={open}
      data-active={count > 0 || undefined}
      onClick={onToggle}
      className={cn(
        'relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11',
        open && 'bg-accent'
      )}
    >
      <Funnel className={cn('size-3.5', count > 0 ? 'text-foreground' : 'text-muted-foreground')} />
      {count > 0 && (
        <span
          data-testid="picker-filter-badge"
          className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[length:calc(var(--ui-font-base)*0.5625)] font-semibold leading-none text-primary-foreground"
        >
          {count}
        </span>
      )}
    </button>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-6 cursor-pointer rounded-md border-[0.8px] px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-9',
        active
          ? 'border-transparent bg-accent text-foreground'
          : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[length:calc(var(--ui-font-base)*0.6875)] font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  )
}

/** The panel under the search box: what to keep, and the order. */
export function PickerFilterPanel({
  facets,
  state,
  onChange,
}: {
  facets: PickerFacets
  state: PickerFilterState
  onChange: (next: PickerFilterState) => void
}) {
  const { t } = useTranslation()
  const sources: [PickerSource, string][] = [
    ['all', t('common:picker.sourceAll')],
    ['local', t('common:picker.sourceLocal')],
    ['cloud', t('common:picker.sourceCloud')],
  ]
  const sortLabels: Record<PickerSort, string> = {
    default: t('common:picker.sortDefault'),
    name: t('common:picker.sortName'),
    recent: t('common:picker.sortRecent'),
    size: t('common:picker.sortSize'),
  }
  const toggleCap = (c: PickerCapability) =>
    onChange({
      ...state,
      capabilities: state.capabilities.includes(c)
        ? state.capabilities.filter((x) => x !== c)
        : [...state.capabilities, c],
    })

  return (
    <div
      data-testid="picker-filter-panel"
      className="mb-1 flex flex-col gap-2 border-b border-border px-2 pb-2"
    >
      {facets.source && (
        <Row label={t('common:picker.source')}>
          {sources.map(([v, text]) => (
            <Chip key={v} active={state.source === v} onClick={() => onChange({ ...state, source: v })}>
              {text}
            </Chip>
          ))}
        </Row>
      )}
      {facets.capabilities.length > 0 && (
        <Row label={t('common:picker.capabilities')}>
          {facets.capabilities.map((c) => (
            <Chip key={c} active={state.capabilities.includes(c)} onClick={() => toggleCap(c)}>
              {t(`common:picker.cap.${c}`)}
            </Chip>
          ))}
        </Row>
      )}
      {facets.loaded && (
        <Row label={t('common:picker.loadedNow')}>
          <Chip active={state.loadedOnly} onClick={() => onChange({ ...state, loadedOnly: !state.loadedOnly })}>
            {t('common:picker.loadedNow')}
          </Chip>
        </Row>
      )}
      {facets.sorts.length > 0 && (
        <Row label={t('common:picker.sort')}>
          {(['default', ...facets.sorts] as PickerSort[]).map((s) => (
            <Chip key={s} active={state.sort === s} onClick={() => onChange({ ...state, sort: s })}>
              {sortLabels[s]}
            </Chip>
          ))}
        </Row>
      )}
      {isFiltered(state) && (
        <button
          type="button"
          onClick={() => onChange({ ...state, source: 'all', capabilities: [], loadedOnly: false, sort: 'default' })}
          className="w-fit cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
        >
          {t('common:picker.clearFilters')}
        </button>
      )}
    </div>
  )
}
