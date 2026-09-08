import { Eye } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Says how much completed tool activity is hidden here, and offers to show it.
 *
 * The activity was never removed -- "Hide completed tool activity" is a filter
 * over the same persisted turns -- so revealing is just turning the filter off
 * for as long as the user wants to look.
 */
export function CoworkHiddenTools({
  count,
  onReveal,
}: {
  count: number
  onReveal: () => void
}) {
  const { t } = useTranslation()
  if (count <= 0) return null
  return (
    <div className="px-1 pb-1" data-testid="hidden-tools">
      <button
        type="button"
        onClick={onReveal}
        data-testid="hidden-tools-reveal"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-main-view-fg/55 hover:bg-main-view-fg/5 hover:text-main-view-fg focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Eye size={12} className="shrink-0" />
        {t('common:coworkDisplay.hiddenCount', { count })}
      </button>
    </div>
  )
}

export default CoworkHiddenTools
