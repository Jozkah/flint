import type { KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'

const BUTTON =
  'flex size-6 items-center justify-center rounded-md hover:text-foreground aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:cursor-default focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11'

/**
 * The `‹ 2/3 ›` control on a message that has other versions (an edited
 * question, a regenerated reply). Reads as one group to a screen reader, with
 * the position spoken ("Version 2 of 3"); Left and Right arrow keys step while
 * focus is inside it.
 *
 * An end button uses `aria-disabled`, not `disabled`: a disabled button drops
 * focus to <body>, which ends keyboard stepping at the first or last version.
 */
export function VersionSwitcher({
  messageId,
  index,
  count,
  onSwitch,
}: {
  messageId: string
  index: number
  count: number
  onSwitch: (messageId: string, dir: -1 | 1) => void
}) {
  const { t } = useTranslation()
  const position = t('chat:version.position', { index, count })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' && index > 1) {
      e.preventDefault()
      onSwitch(messageId, -1)
    } else if (e.key === 'ArrowRight' && index < count) {
      e.preventDefault()
      onSwitch(messageId, 1)
    }
  }

  return (
    <div
      role="group"
      aria-label={t('chat:version.group')}
      className="flex items-center gap-0.5 text-muted-foreground"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className={BUTTON}
        aria-disabled={index <= 1}
        onClick={() => index > 1 && onSwitch(messageId, -1)}
        title={t('chat:version.previous')}
        aria-label={t('chat:version.previousAt', { index, count })}
      >
        <ChevronLeft className="size-3.5" aria-hidden />
      </button>
      <span
        className="tabular-nums"
        role="status"
        aria-live="polite"
        aria-label={position}
      >
        {index}/{count}
      </span>
      <button
        type="button"
        className={BUTTON}
        aria-disabled={index >= count}
        onClick={() => index < count && onSwitch(messageId, 1)}
        title={t('chat:version.next')}
        aria-label={t('chat:version.nextAt', { index, count })}
      >
        <ChevronRight className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}
