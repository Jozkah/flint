import { memo, type HTMLAttributes, type ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Clock,
  CornerDownRight,
  GripVertical,
  Pencil,
  X,
} from 'lucide-react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { queueDropTarget } from '@/lib/queueDrag'
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
  /**
   * Send a held message (one the run it was typed for did not take). Held
   * messages show Send and Discard instead of Steer.
   */
  onRelease?: (id: string) => void
  /**
   * Props for the drag handle (dnd-kit listeners and attributes). Absent when
   * the chip is not in a sortable list.
   */
  dragHandleProps?: HTMLAttributes<HTMLButtonElement>
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
  onRelease,
  dragHandleProps,
}: QueuedMessageChipProps) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="queued-message-chip"
      className="flex h-6 max-w-full items-center gap-1.5 rounded-md bg-accent pr-1 pl-2 text-xs text-secondary-foreground"
    >
      {dragHandleProps && (
        // Pointer only: the arrow buttons are the keyboard way to reorder.
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          title={t('common:queue.drag')}
          data-testid="queued-drag-handle"
          className="-ml-1 flex shrink-0 cursor-grab touch-none items-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
          {...dragHandleProps}
        >
          <GripVertical className="size-3.5" />
        </button>
      )}
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
        {message.held ? (
          <>
            <span
              data-testid="queued-held"
              className="text-[11px] text-muted-foreground"
              title={t('common:queue.heldHint')}
            >
              {t('common:queue.held')}
            </span>
            {onRelease && (
              <button
                type="button"
                data-testid="queued-send"
                className="shrink-0 rounded-md px-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
                onClick={() => onRelease(message.id)}
              >
                {t('common:steering.send')}
              </button>
            )}
          </>
        ) : message.steer ? (
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
            label={
              message.held
                ? t('common:steering.discard')
                : t('common:queue.remove')
            }
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

function SortableQueuedMessage(
  props: Omit<QueuedMessageChipProps, 'dragHandleProps'>
) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.message.id })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      <QueuedMessageChip
        {...props}
        dragHandleProps={{ ...attributes, ...listeners, tabIndex: -1 }}
      />
    </div>
  )
}

type QueuedMessageListProps = {
  messages: QueuedMessage[]
  /** Drag and drop: put `id` where `overId` is. */
  onReorder?: (id: string, overId: string) => void
  /** Per-message chip props; the list adds the drag handle. */
  chipProps: (
    message: QueuedMessage,
    index: number
  ) => Omit<QueuedMessageChipProps, 'message' | 'dragHandleProps'>
}

/**
 * The queued chips, reorderable by dragging their handle when there is more
 * than one. The arrow buttons on each chip stay for keyboard use.
 */
export function QueuedMessageList({
  messages,
  onReorder,
  chipProps,
}: QueuedMessageListProps) {
  // A few pixels of travel before a drag starts, so a click on the chip's
  // text or buttons is still a click.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )
  if (!onReorder || messages.length < 2) {
    return (
      <>
        {messages.map((m, i) => (
          <QueuedMessageChip key={m.id} message={m} {...chipProps(m, i)} />
        ))}
      </>
    )
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event) => {
        const drop = queueDropTarget(event)
        if (drop) onReorder(drop.id, drop.overId)
      }}
    >
      <SortableContext
        items={messages.map((m) => m.id)}
        strategy={verticalListSortingStrategy}
      >
        {messages.map((m, i) => (
          <SortableQueuedMessage key={m.id} message={m} {...chipProps(m, i)} />
        ))}
      </SortableContext>
    </DndContext>
  )
}
