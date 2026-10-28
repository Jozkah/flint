import { ExtensionManager } from '@/lib/extension'
import { ConversationalExtension, ExtensionTypeEnum } from '@janhq/core'

/**
 * The Conversational extension, or a rejection while it is not registered
 * yet (startup race). Writes must fail loudly here: a silent no-op would let
 * the UI believe a thread or message was saved. The message matches the one
 * `fetchThreads` throws so retry logic keyed on it keeps working.
 */
export function requireConversational(): ConversationalExtension {
  const ext = ExtensionManager.getInstance().get<ConversationalExtension>(
    ExtensionTypeEnum.Conversational
  )
  if (!ext) throw new Error('Conversational extension not available yet')
  return ext
}
