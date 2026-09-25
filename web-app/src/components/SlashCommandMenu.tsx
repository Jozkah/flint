/**
 * The `/` menu shared by every composer (Home, Cowork, Rooms).
 *
 * Focus stays in the composer: it moves the active row with the arrow keys
 * (see `useSlashCommands.onKeyDown`) and points `aria-activedescendant` at
 * `slashOptionId(listId, activeIndex)`. Mouse hover moves the active row too,
 * and a click picks it.
 */
import { useEffect, useRef } from 'react'
import { Puzzle, Sparkles, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { slashOptionId, type SlashItem } from '@/lib/slashCommands'

const ICONS = {
  plugin: Puzzle,
  skill: Sparkles,
  builtin: TerminalSquare,
} as const

type Props = {
  items: SlashItem[]
  activeIndex: number
  listId: string
  /** Show every command under a "help" heading rather than as matches. */
  help?: boolean
  onActiveChange: (index: number) => void
  onSelect: (item: SlashItem) => void
  className?: string
}

export function SlashCommandMenu({
  items,
  activeIndex,
  listId,
  help,
  onActiveChange,
  onSelect,
  className,
}: Props) {
  const { t } = useTranslation()
  const rows = useRef<Map<number, HTMLDivElement>>(new Map())

  useEffect(() => {
    rows.current.get(activeIndex)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div
      className={cn(
        'absolute bottom-full left-0 z-50 mb-2 w-full max-w-[480px] rounded-lg border border-border bg-popover p-1 shadow-popover',
        className
      )}
      data-testid="slash-menu"
    >
      <div className="mb-1 border-b border-border/50 px-2 py-1.5 text-xs text-muted-foreground">
        {help ? t('slash:menu.helpTitle') : t('slash:menu.title')}
        <span className="block text-[10px] opacity-60">{t('slash:menu.keys')}</span>
      </div>
      {items.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('slash:menu.empty')}</p>
      ) : (
        <div
          id={listId}
          role="listbox"
          aria-label={t('slash:menu.title')}
          className="max-h-[280px] overflow-y-auto"
        >
          {items.map((item, index) => {
            const Icon = ICONS[item.source]
            const selected = index === activeIndex
            return (
              <div
                key={item.id}
                id={slashOptionId(listId, index)}
                role="option"
                aria-selected={selected}
                data-testid="slash-option"
                ref={(el) => {
                  if (el) rows.current.set(index, el)
                  else rows.current.delete(index)
                }}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm',
                  selected ? 'bg-accent text-foreground' : 'text-fg-2'
                )}
                onMouseEnter={() => onActiveChange(index)}
                // Keep focus in the composer.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(item)}
              >
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono font-medium">/{item.trigger}</span>
                    {item.argumentHint && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {item.argumentHint}
                      </span>
                    )}
                  </div>
                  {item.description && (
                    <div className="truncate text-xs text-muted-foreground" title={item.description}>
                      {item.description}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {item.plugin && item.source === 'plugin'
                    ? t('slash:source.pluginNamed', { plugin: item.plugin })
                    : t(`slash:source.${item.source}`)}
                  {item.scope && ` · ${t(`slash:scope.${item.scope}`)}`}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
