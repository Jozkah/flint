import { CircleSlash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { MAX_SESSION_TOKENS } from '@/lib/coworkBudget'

type Props =
  | { kind: 'steps'; max: number; onContinue: () => void }
  | {
      kind: 'tokens'
      /**
       * Which cap stopped the run. `window`: the next request would not fit
       * the model's context window (`detail` says by how much). `budget`: the
       * request spent its token allowance. They are fixed in different
       * places, so the notice has to say which one it was.
       */
      cause?: 'window' | 'budget'
      detail?: string
      /** Absent while Cowork has no compaction to run: no button, then. */
      onCompact?: () => void
      onNewSession: () => void
    }

/**
 * Why a run stopped short of an answer.
 *
 * Deliberately not styled as an error: hitting a step cap is routine on a long
 * task, and colouring it red trains people to read a normal event as a failure
 * — after which they stop reading the ones that matter.
 */
export function CoworkBudgetNotice(props: Props) {
  const { t } = useTranslation()

  return (
    <div
      role="status"
      data-testid="cowork-budget-notice"
      className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <CircleSlash size={14} aria-hidden className="shrink-0" />
      {props.kind === 'steps' ? (
        <>
          <span>{t('common:budget.stoppedSteps', { max: props.max })}</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={props.onContinue}
          >
            {t('common:budget.keepGoing')}
          </Button>
        </>
      ) : (
        <>
          <span>
            {props.cause === 'window'
              ? t('common:budget.stoppedWindow', { detail: props.detail ?? '' })
              : t('common:budget.stoppedTokens', {
                  max: MAX_SESSION_TOKENS.toLocaleString(),
                })}
          </span>
          {props.onCompact ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={props.onCompact}
            >
              {t('common:budget.compact')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={props.onNewSession}
          >
            {t('common:budget.newSession')}
          </Button>
        </>
      )}
    </div>
  )
}
