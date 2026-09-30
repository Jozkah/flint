import { CoworkWorkProfilePicker } from '@/containers/CoworkWorkProfilePicker'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'

/**
 * A conversation's work profile in the chat composer, the same menu Cowork
 * shows. Only rendered while work profiles are on, and only once the thread
 * exists: a profile is remembered per thread id, and the new-chat screen has
 * none until the first message is sent (Auto picks then).
 */
export function ChatWorkProfilePicker({ threadId }: { threadId: string }) {
  const enabled = useWorkProfiles((s) => s.enabled)
  const choice = useWorkProfiles((s) => s.sessions[threadId])
  if (!enabled) return null
  return (
    <CoworkWorkProfilePicker
      variant="quiet"
      choice={choice}
      onChoose={(id) => useWorkProfiles.getState().choose(threadId, id, true)}
      onAuto={() => useWorkProfiles.getState().clearManual(threadId)}
    />
  )
}
