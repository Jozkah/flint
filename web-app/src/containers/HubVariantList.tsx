import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { HuggingFaceFileGroup } from '@/lib/huggingface'
import {
  WINDOW_SIZE,
  groupVariants,
  selectShortList,
} from '@/lib/hubVariants'

type Props = {
  variants: HuggingFaceFileGroup[]
  recommendedId?: string | null
  renderRow: (group: HuggingFaceFileGroup) => ReactNode
}

/**
 * A model's variants without a page-long list: a short recommended set first,
 * then "Show all N variants" opens the rest in a bounded, internally scrolling
 * area with a sticky header. Long lists get family headings and are windowed.
 */
export function HubVariantList({ variants, recommendedId, renderRow }: Props) {
  const { t } = useTranslation()
  const [showAll, setShowAll] = useState(false)
  const [windowed, setWindowed] = useState(WINDOW_SIZE)

  const short = useMemo(
    () => selectShortList(variants, recommendedId),
    [variants, recommendedId]
  )
  const canCollapse = variants.length > short.length

  if (!canCollapse) {
    return <div className="space-y-1">{variants.map(renderRow)}</div>
  }

  if (!showAll) {
    return (
      <div className="space-y-1">
        {short.map(renderRow)}
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setShowAll(true)}
          className="mt-1 w-full cursor-pointer rounded-lg px-3 py-2 text-left text-xs font-medium text-secondary-foreground hover:bg-card hover:text-foreground"
        >
          {t('sweep:hub.showAllVariants', { total: variants.length })}
        </button>
      </div>
    )
  }

  const sections = groupVariants(variants)
  let budget = windowed
  return (
    <div>
      <div className="max-h-80 overflow-y-auto overscroll-contain rounded-xl [scrollbar-gutter:stable]">
        <div className="sticky top-0 z-10 flex items-center justify-between bg-muted px-3 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          <span>{t('sweep:hub.variant')}</span>
          <span>{t('sweep:hub.sizeAndFit')}</span>
        </div>
        <div className="space-y-1 pt-1">
          {sections.map((section, index) => {
            const items = section.items.slice(0, Math.max(budget, 0))
            budget -= items.length
            if (!items.length) return null
            return (
              <Fragment key={section.title ?? index}>
                {section.title && (
                  <div className="px-3 pt-2 text-[11px] font-medium text-muted-foreground">
                    {section.title}
                  </div>
                )}
                {items.map(renderRow)}
              </Fragment>
            )
          })}
          {variants.length > windowed && (
            <button
              type="button"
              onClick={() => setWindowed((n) => n + WINDOW_SIZE)}
              className="w-full cursor-pointer rounded-lg px-3 py-2 text-left text-xs font-medium text-secondary-foreground hover:bg-card"
            >
              Load more ({variants.length - windowed} left)
            </button>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-expanded
        onClick={() => {
          setShowAll(false)
          setWindowed(WINDOW_SIZE)
        }}
        className="mt-1 w-full cursor-pointer rounded-lg px-3 py-2 text-left text-xs font-medium text-secondary-foreground hover:bg-card hover:text-foreground"
      >
        {t('sweep:hub.showFewer')}
      </button>
    </div>
  )
}
