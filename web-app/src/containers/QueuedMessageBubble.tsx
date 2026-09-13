import { memo } from 'react'
import { Clock, X } from 'lucide-react'
import type { QueuedMessage } from '@/stores/message-queue-store'

type QueuedMessageChipProps = {
  message: QueuedMessage
  onEdit?: (message: QueuedMessage) => void
  onRemove?: (id: string) => void
}

// Compact chip for a queued message, displayed inside the chat input area.
// Click the text to edit it (puts it back in the input), click X to discard.
export const QueuedMessageChip = memo(function QueuedMessageChip({
  message,
  onEdit,
  onRemove,
}: QueuedMessageChipProps) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-sunken border border-border text-sm max-w-full">
      <Clock className="size-3.5 shrink-0 text-muted-foreground animate-pulse motion-reduce:animate-none" aria-hidden />
      <span
        className="min-w-0 truncate text-ink-2 cursor-pointer hover:text-foreground transition-colors"
        onClick={() => onEdit?.(message)}
        title="Click to edit"
      >
        {message.text}
      </span>
      {onRemove && (
        <button
          type="button"
          className="ml-auto flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11"
          onClick={() => onRemove(message.id)}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
})
