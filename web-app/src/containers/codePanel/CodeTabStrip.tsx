import { Columns2, FolderTree, X, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  focusTab,
  neighbourTabId,
  tabId,
  type CodePanelState,
  type CodeTab,
} from '@/lib/coworkCode'
import { isDirty, type Buffers } from '@/lib/coworkCodeEdit'

type Props = {
  state: CodePanelState
  buffers: Buffers
  explorerOpen: boolean
  onToggleExplorer: () => void
  onStateChange: (next: CodePanelState) => void
  /** Close tabs, asking first when any of them holds unsaved edits. */
  requestClose: (ids: string[], next: CodePanelState) => void
}

/** A human phrase for where a tab's file lives, for its tooltip. */
function originTitle(tab: CodeTab, t: (key: string) => string): string {
  switch (tab.origin.kind) {
    case 'project':
      return t('common:codePanel.originProject')
    case 'sandbox':
    case 'artifact':
      return t('common:codePanel.originWorkspace')
    case 'external':
      return t('common:codePanel.originExternal')
  }
}

/** The Code rail's open-file tabs, with the explorer toggle and bulk close. */
export function CodeTabStrip({
  state,
  buffers,
  explorerOpen,
  onToggleExplorer,
  onStateChange,
  requestClose,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="tablist"
      aria-label={t('common:codePanel.openFiles')}
      className="flex min-h-[38px] shrink-0 flex-wrap items-center gap-1 border-b border-dashed border-border px-2 py-1.5"
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common:codePanel.explorer')}
        aria-pressed={explorerOpen}
        onClick={onToggleExplorer}
        className={cn(
          'shrink-0',
          explorerOpen ? 'bg-accent text-foreground' : 'text-muted-foreground'
        )}
      >
        <FolderTree className="size-3.5" />
      </Button>
      {state.tabs.map((tab) => {
        const id = tabId(tab)
        const name = tab.path.split('/').pop() || tab.path
        const isActive = id === state.activeTabId
        return (
          <div
            key={id}
            role="tab"
            aria-selected={isActive}
            className={cn(
              'group flex h-[26px] shrink-0 cursor-pointer items-center gap-1 rounded-md border-[0.8px] pr-1 pl-2.5 font-mono text-xs outline-none transition-[background-color,border-color] duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/40',
              isActive
                ? 'border-border bg-card text-foreground shadow-[0_1px_3px_rgba(0,0,0,.06)]'
                : 'border-transparent text-muted-foreground hover:bg-hover-row'
            )}
            title={`${tab.path} — ${originTitle(tab, t)}`}
            onClick={() => onStateChange(focusTab(state, id))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onStateChange(focusTab(state, id))
              } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                // Left/right move between tabs, as in a real tablist.
                e.preventDefault()
                const next = neighbourTabId(
                  state,
                  e.key === 'ArrowRight' ? 1 : -1
                )
                if (next) onStateChange(focusTab(state, next))
              } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault()
                requestClose([id], closeTab(state, id))
              }
            }}
            tabIndex={isActive ? 0 : -1}
          >
            {tab.origin.kind !== 'project' && (
              // A sandbox or generated file is not the user's project;
              // say so rather than letting the name imply it.
              <span aria-hidden className="shrink-0 text-xs text-muted-foreground">
                {tab.origin.kind === 'external' ? 'ext' : 'ws'}
              </span>
            )}
            <span className="max-w-40 truncate">{name}</span>
            <button
              type="button"
              aria-label={
                isDirty(buffers[id])
                  ? t('common:codePanel.closeTabUnsaved', { name })
                  : t('common:codePanel.closeTab', { name })
              }
              onClick={(e) => {
                e.stopPropagation()
                requestClose([id], closeTab(state, id))
              }}
              className="group/close grid h-[22px] w-[18px] place-items-center rounded-sm text-muted-foreground opacity-50 transition-opacity hover:text-foreground hover:opacity-100"
            >
              {isDirty(buffers[id]) ? (
                // Unsaved: a dot, which turns back into the close
                // cross under the pointer, as in VS Code.
                <>
                  <span
                    data-testid="tab-dirty"
                    aria-hidden
                    className="size-2 rounded-full bg-foreground opacity-100 group-hover/close:hidden"
                  />
                  <X size={11} className="hidden group-hover/close:block" />
                </>
              ) : (
                <X size={11} />
              )}
            </button>
          </div>
        )
      })}
      {state.tabs.length > 1 && (
        <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('common:codePanel.closeOthers')}
            onClick={() => {
              const keep = state.activeTabId
              if (!keep) return
              requestClose(
                state.tabs.map(tabId).filter((id) => id !== keep),
                closeOtherTabs(state, keep)
              )
            }}
            className="text-muted-foreground"
          >
            <Columns2 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('common:codePanel.closeAll')}
            onClick={() => requestClose(state.tabs.map(tabId), closeAllTabs(state))}
            className="text-muted-foreground"
          >
            <XCircle className="size-3.5" />
          </Button>
        </span>
      )}
    </div>
  )
}
