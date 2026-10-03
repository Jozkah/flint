import { ListFilter } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useModelFilter } from '@/hooks/useModelFilter'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/**
 * The same switch as one plain toggle button, for pickers that are themselves
 * a menu: a menu opened from inside a menu would close the one behind it.
 */
export function ModelFilterToggle() {
  const { t } = useTranslation()
  const hide = useModelFilter((s) => s.hideUnavailable)
  const setHide = useModelFilter((s) => s.setHideUnavailable)
  const label = t('common:hideUnavailableModels')
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={hide}
      title={`${label} — ${t('common:hideUnavailableModelsHint')}`}
      onClick={() => setHide(!hide)}
      className={cn(
        'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11',
        hide ? 'bg-accent text-foreground' : 'text-muted-foreground'
      )}
    >
      <ListFilter className="size-3.5" />
    </button>
  )
}

/**
 * The filter button beside the search box in every model picker. One switch,
 * shared by all of them: hide models with no API key set up, or whose
 * provider is not answering.
 */
export function ModelFilterButton({ className }: { className?: string }) {
  const { t } = useTranslation()
  const hide = useModelFilter((s) => s.hideUnavailable)
  const setHide = useModelFilter((s) => s.setHideUnavailable)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('common:filterModels')}
          title={t('common:filterModels')}
          data-active={hide || undefined}
          className={cn(
            'relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11',
            className
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <ListFilter
            className={cn(
              'size-3.5',
              hide ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
          {hide && (
            <span
              aria-hidden
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t('common:filterModels')}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={hide}
          onCheckedChange={(checked) => setHide(checked === true)}
          // Toggling should not close the picker behind the menu.
          onSelect={(e) => e.preventDefault()}
          className="items-start"
        >
          <span className="flex flex-col gap-0.5">
            <span>{t('common:hideUnavailableModels')}</span>
            <span className="text-xs text-muted-foreground">
              {t('common:hideUnavailableModelsHint')}
            </span>
          </span>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
