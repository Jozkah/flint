import { useEffect, useRef } from 'react'
import { Paperclip } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

/**
 * The composer's drop target while files are dragged over it: a dashed border
 * that draws in and marches, a blur over the content, and a centred hint.
 * Mount inside a `relative` box; it is inert (pointer-events none) and renders
 * nothing while `active` is false.
 */
export function DropRim({ active }: { active: boolean }) {
  const { t } = useTranslation()
  const storeReduced = useInterfaceSettings((s) => s.reduceMotion)
  const osReduced = useReducedMotion()
  const reduced = storeReduced || !!osReduced
  const rootRef = useRef<HTMLDivElement | null>(null)
  const rectRef = useRef<SVGRectElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    const rect = rectRef.current
    if (!active || !root || !rect) return
    const fit = () => {
      const { width, height } = root.getBoundingClientRect()
      if (!width || !height) return
      rect.setAttribute('x', '1')
      rect.setAttribute('y', '1')
      rect.setAttribute('width', String(width - 2))
      rect.setAttribute('height', String(height - 2))
      rect.setAttribute('rx', '11')
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(root)
    return () => observer.disconnect()
  }, [active])

  if (!active) return null

  return (
    <div
      ref={rootRef}
      className="dr-root"
      data-testid="drop-rim"
      data-reduced={reduced ? '' : undefined}
      aria-hidden="true"
    >
      <span className="dr-veil" />
      <svg className="dr-rim">
        <rect ref={rectRef} />
      </svg>
      <span className="dr-hint">
        <span className="dr-clip">
          <Paperclip className="size-4" />
        </span>
        <span>{t('common:drop.releaseToAttach')}</span>
      </span>
    </div>
  )
}
