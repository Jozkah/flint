import { useEffect, useRef } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/**
 * The Restore / Delete permanently menu of an archived item. It opens at a
 * point (right-click, Shift+F10 or the menu key, or the item's More button),
 * takes focus, moves with the arrow keys and closes on Escape or a click
 * outside. The caller decides what each choice does.
 */
export function ArchiveContextMenu({
  x,
  y,
  onRestore,
  onDelete,
  onClose,
}: {
  x: number
  y: number
  onRestore: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [onClose])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
    )
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const step = e.key === 'ArrowDown' ? 1 : -1
    items[(at + step + items.length) % items.length]?.focus()
  }

  const item = 'flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs outline-hidden hover:bg-accent focus-visible:bg-accent'

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('archive:menuLabel')}
      data-testid="archive-context-menu"
      className="fixed z-50 min-w-40 rounded-lg border border-border bg-card p-1 shadow-lift"
      style={{ left: x, top: y }}
      onKeyDown={onKeyDown}
    >
      <button type="button" role="menuitem" className={item} onClick={onRestore}>
        {t('archive:restore')}
      </button>
      <button
        type="button"
        role="menuitem"
        className={cn(item, 'text-destructive')}
        onClick={onDelete}
      >
        {t('archive:deletePermanently')}
      </button>
    </div>
  )
}
