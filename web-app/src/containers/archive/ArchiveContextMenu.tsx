import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

const EDGE = 8

/**
 * Where a menu of this size opened at (x, y) fits in the window: flipped to the
 * other side of the point when it would overflow, then clamped to the margin.
 */
export function fitToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  vw = window.innerWidth,
  vh = window.innerHeight
): { left: number; top: number } {
  let left = x
  let top = y
  if (left + width > vw - EDGE) left = x - width
  if (top + height > vh - EDGE) top = y - height
  return {
    left: Math.max(EDGE, Math.min(left, vw - width - EDGE)),
    top: Math.max(EDGE, Math.min(top, vh - height - EDGE)),
  }
}

/**
 * The Restore / Delete permanently menu of an archived item. It opens at a
 * point (right-click, Shift+F10 or the menu key, or the item's More button),
 * takes focus, moves with the arrow keys and closes on Escape or a click
 * outside. The caller decides what each choice does.
 */
export function ArchiveContextMenu({
  x,
  y,
  onPreview,
  onRestore,
  onDelete,
  onClose,
}: {
  x: number
  y: number
  onPreview?: () => void
  onRestore: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  // Opened at the pointer, then pulled back inside the window: a menu opened
  // near the right or bottom edge used to be cut off ("Delete perm...").
  const [at, setAt] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    setAt(fitToViewport(x, y, box?.width ?? 0, box?.height ?? 0))
  }, [x, y])

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
      style={at}
      onKeyDown={onKeyDown}
    >
      {onPreview && (
        <button type="button" role="menuitem" className={item} onClick={onPreview}>
          {t('archive:preview')}
        </button>
      )}
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
