import { Scissors } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/**
 * A reply that hit its output limit ends mid-sentence; this says so, once,
 * under the reply, with a way to carry on (L-002). Used by chat and rooms.
 */
export function ReplyCutOff({
  tokens,
  onContinue,
  className,
}: {
  /** The reply's output tokens, when known. */
  tokens?: number | null
  /** Asks the model to carry on; no button without it. */
  onContinue?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <p
      role="note"
      data-testid="reply-cut-off"
      className={cn('flex flex-wrap items-center gap-1.5 text-xs text-warning', className)}
    >
      <Scissors aria-hidden className="size-3 shrink-0" />
      <span>
        {tokens
          ? t('common:replyCutOff.withTokens', { tokens: tokens.toLocaleString() })
          : t('common:replyCutOff.plain')}
      </span>
      {onContinue && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={onContinue}
            className="cursor-pointer font-medium underline-offset-2 hover:underline"
          >
            {t('common:continue')}
          </button>
        </>
      )}
    </p>
  )
}
