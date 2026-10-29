import { withdrawApprovalsForSteering } from '@/lib/chatSteering'
import { useMessageQueue } from '@/stores/message-queue-store'
import type { QueuedMessage } from '@/stores/message-queue-store'
import { QueuedMessageList } from '@/containers/QueuedMessageBubble'

/**
 * The messages queued behind a run, as chips above the editor: edit, remove,
 * reorder, send a held one, and steer the running turn.
 */
export function ComposerQueue({
  queueId,
  messages,
  busy,
  onEdit,
  onStopForSteer,
}: {
  queueId: string
  messages: QueuedMessage[]
  /** A run is working (streaming, or its tools still pending or running). */
  busy: boolean
  /** Put a queued message's text back in the composer (it leaves the queue). */
  onEdit: (text: string) => void
  /** Stop the run so the steering message goes as the next turn. */
  onStopForSteer: () => void
}) {
  const queue = () => useMessageQueue.getState()
  const remove = (id: string) => queue().removeMessage(queueId, id)
  return (
    <div className="flex flex-col gap-1 px-3 pt-2 pb-0">
      <QueuedMessageList
        messages={messages}
        onReorder={(id, overId) => queue().reorder(queueId, id, overId)}
        chipProps={(msg, index) => ({
          onEdit: (queued) => {
            // Put the text back in the input for editing, remove from queue
            onEdit(queued.text)
            remove(queued.id)
          },
          onRemove: remove,
          // A held message (its run failed or was stopped) waits
          // for the user: Send lets it go as the next turn.
          onRelease: msg.held
            ? (id) => queue().release(queueId, id)
            : undefined,
          // Steering only means something while a run works; a
          // held message waits for the user and is sent, not steered.
          onSteer:
            busy && !msg.held && !msg.from
              ? (id) => {
                  queue().steerNow(queueId, id)
                  withdrawApprovalsForSteering(queueId)
                }
              : undefined,
          // Already steering and the run still works: stop the
          // run (steering stays queued, not held) and the end-of-run
          // sender hands it over first, as the immediate next turn.
          onSteerNow: busy && msg.steer && !msg.held ? onStopForSteer : undefined,
          onMoveUp:
            index > 0 ? (id) => queue().move(queueId, id, -1) : undefined,
          onMoveDown:
            index < messages.length - 1
              ? (id) => queue().move(queueId, id, 1)
              : undefined,
        })}
      />
    </div>
  )
}
