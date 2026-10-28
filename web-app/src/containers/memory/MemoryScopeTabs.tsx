import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { MemoryScope } from '@janhq/tauri-plugin-agent-tools-api'
import { TAB_SCOPES } from './memoryScopes'

type Props = {
  scope: MemoryScope
  /** Picks a scope; the page also resets its paging. */
  onSelect: (scope: MemoryScope) => void
  tabCount: (scope: MemoryScope) => number | null
}

/** Scopes as tabs: an accent underline marks the one shown. */
export function MemoryScopeTabs({ scope, onSelect, tabCount }: Props) {
  const { t } = useTranslation()
  return (
            <div
              role="tablist"
              aria-label={t('settings:memoryPage.tabsAria')}
              className="flex min-w-0 max-w-full flex-wrap items-end gap-1 border-b border-border"
            >
              {TAB_SCOPES.map((tabScope) => (
                <button
                  key={tabScope}
                  type="button"
                  role="tab"
                  aria-selected={tabScope === scope}
                  // The name stays the label alone; the count is decoration.
                  aria-label={t(`settings:memoryPage.scope.${tabScope}.tab`)}
                  className={cn(
                    'relative shrink-0 whitespace-nowrap px-3 pt-2 pb-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11',
                    tabScope === scope
                      ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => onSelect(tabScope)}
                >
                  {t(`settings:memoryPage.scope.${tabScope}.tab`)}
                  {tabCount(tabScope) !== null && (
                    <span
                      className={cn(
                        'ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[length:calc(var(--ui-font-base)*0.6875)] tabular-nums',
                        tabScope === scope
                          ? 'bg-primary/12 text-foreground'
                          : 'bg-muted text-muted-foreground'
                      )}
                      data-testid={`memory-tab-count-${tabScope}`}
                      aria-hidden
                    >
                      {tabCount(tabScope)}
                    </span>
                  )}
                </button>
              ))}
            </div>
  )
}
