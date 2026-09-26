import { memo, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Clock, CornerDownRight, Pencil, X } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { QueuedMessage } from '@/stores/message-queue-store'

type QueuedMessageChipProps = {
  message: QueuedMessage
  /** Put the text back in the composer and take it out of the queue. */
  onEdit?: (message: QueuedMessage) => void
  onRemove?: (id: string) => void
  /**
   * Hand the message to the running turn at its next safe point instead of
   * waiting for the run to end. Absent when there is no run to steer.
   */
  onSteer?: (id: string) => void
  onMoveUp?: (id: string) => void
  onMoveDown?: (id: string) => void
}

function ChipButton({
  label,
  onClick,
  children,
  testId,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  testId: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      className="flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

// Compact chip for a queued message, displayed inside the chat input area.
// A queued message goes as its own turn once the run ends, in queue order.
// Click the text (or the pencil) to edit it, steer to hand it to the running
// turn, the arrows to reorder, X to discard.
export const QueuedMessageChip = memo(function QueuedMessageChip({
  message,
  onEdit,
  onRemove,
  onSteer,
  onMoveUp,
  onMoveDown,
}: QueuedMessageChipProps) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="queued-message-chip"
      className="flex h-6 max-w-full items-center gap-1.5 rounded-md bg-accent pr-1 pl-2 text-xs text-secondary-foreground"
    >
      {message.steer ? (
        <CornerDownRight
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label={t('common:queue.steering')}
        />
      ) : (
        <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span
        className="min-w-0 truncate text-secondary-foreground cursor-pointer hover:text-foreground transition-colors"
        onClick={() => onEdit?.(message)}
        title={t('common:queue.edit')}
      >
        {message.text}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {message.steer ? (
          <span
            data-testid="queued-steering"
            className="text-[11px] text-muted-foreground"
            title={t('common:queue.steeringHint')}
          >
            {t('common:queue.steering')}
          </span>
        ) : (
          onSteer && (
            <button
              type="button"
              data-testid="queued-steer"
              title={t('common:queue.steerHint')}
              className="shrink-0 rounded-md px-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
              onClick={() => onSteer(message.id)}
            >
              {t('common:queue.steer')}
            </button>
          )
        )}
        {onMoveUp && (
          <ChipButton
            label={t('common:queue.moveUp')}
            testId="queued-move-up"
            onClick={() => onMoveUp(message.id)}
          >
            <ArrowUp className="size-3.5" />
          </ChipButton>
        )}
        {onMoveDown && (
          <ChipButton
            label={t('common:queue.moveDown')}
            testId="queued-move-down"
            onClick={() => onMoveDown(message.id)}
          >
            <ArrowDown className="size-3.5" />
          </ChipButton>
        )}
        {onEdit && (
          <ChipButton
            label={t('common:queue.edit')}
            testId="queued-edit"
            onClick={() => onEdit(message)}
          >
            <Pencil className="size-3.5" />
          </ChipButton>
        )}
        {onRemove && (
          <ChipButton
            label={t('common:queue.remove')}
            testId="queued-remove"
            onClick={() => onRemove(message.id)}
          >
            <X className="size-3.5" />
          </ChipButton>
        )}
      </div>
    </div>
  )
})
