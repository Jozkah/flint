import { CircleSlash, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Props =
  | { kind: 'stopped' }
  | { kind: 'error'; message?: string; onRetry: () => void }
  /**
   * A run stopped by one of its own limits. AH-019/AH-021/AH-029.
   *
   * Not styled as a failure: reaching a time limit, or being stopped for going
   * in circles, is the guard working. It still offers to try again, because
   * the next attempt may be the one that gets somewhere.
   */
  | {
      kind: 'deadline' | 'timeout' | 'loop'
      message?: string
      onRetry: () => void
      /**
       * Set when the session has no folder: a run stopped for hitting the same
       * wall is often one that needed the project, so offer to attach it.
       */
      onAttachFolder?: () => void
    }

/**
 * How a run ended when it ended without an answer.
 *
 * Split from the budget notice by weight, not by wording: a stop is something
 * the user just did and needs no colour, while a failure is the one state on
 * this surface that should look like one. Neither is a tool call, which is what
 * they used to be rendered as — a fake `error` tool whose card claimed the agent
 * had run something.
 */
export function CoworkRunNotice(props: Props) {
  const { t } = useTranslation()

  if (props.kind !== 'stopped' && props.kind !== 'error') {
    return (
      <div
        role="status"
        data-testid="cowork-run-notice"
        className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      >
        <CircleSlash size={14} aria-hidden className="shrink-0" />
        <span className="min-w-0 break-words">
          {t(`common:run.${props.kind}`)}
        </span>
        {props.message?.trim() ? (
          <span className="min-w-0 break-words text-fg-2">{props.message}</span>
        ) : null}
        {props.onAttachFolder ? (
          <Button
            variant="default"
            size="sm"
            className="h-7 pointer-coarse:h-11"
            onClick={props.onAttachFolder}
          >
            {t('common:run.attachFolder')}
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="h-7 pointer-coarse:h-11"
          onClick={props.onRetry}
        >
          {t('common:run.tryAgain')}
        </Button>
      </div>
    )
  }

  if (props.kind === 'stopped') {
    return (
      <div
        role="status"
        data-testid="cowork-run-notice"
        className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"
      >
        <CircleSlash size={14} aria-hidden className="shrink-0" />
        <span>{t('common:run.stopped')}</span>
      </div>
    )
  }

  return (
    <div
      role="alert"
      data-testid="cowork-run-notice"
      className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive"
    >
      <TriangleAlert size={14} aria-hidden className="shrink-0" />
      {/* Always the words, then the detail: a raw error message alone does not
          say that the run failed. */}
      <span className="min-w-0 break-words">
        <span className="font-medium">{t('common:run.failed')}</span>
        {props.message?.trim() ? (
          <span className="text-foreground"> {props.message.trim()}</span>
        ) : null}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 pointer-coarse:h-11"
        onClick={props.onRetry}
      >
        {t('common:run.tryAgain')}
      </Button>
    </div>
  )
}
