import { NULL_DEVICE_RETRY_REASON } from '@/lib/nullDeviceRetryReason'

/**
 * Whether a pending request may have its command rewritten. The prompt that
 * offers a failed command outside the sandbox runs the stored original, so an
 * edit made there would be ignored and the unedited command would run
 * unconfined: that prompt has no edit.
 */
export function commandEditable(entry: {
  toolName: string
  taskContext?: string
  conversationProgram?: string
}): boolean {
  return (
    entry.toolName === 'bash' &&
    entry.conversationProgram === undefined &&
    entry.taskContext !== NULL_DEVICE_RETRY_REASON
  )
}
