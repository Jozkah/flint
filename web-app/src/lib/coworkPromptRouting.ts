import type { UIMessage } from 'ai'
import { useAssistant } from '@/hooks/useAssistant'
import { routeModelForTurn, type ModelSelection } from '@/lib/jevModelTurn'
import { chooseJevPromptRoute, type JevSuggestedMode } from '@/lib/jevRouting'
import { latestUserMessage } from '@/lib/coworkTransportMessages'

/**
 * Jev's per-message choices for a Cowork session: which AI model answers the
 * message and which assistant (with its instructions and a suggested mode).
 * Owned by `CoworkChatTransport`; one decision per user message, never one per
 * tool-loop step, so a run keeps one model and one assistant for its turn.
 */
export class CoworkPromptRouter {
  private lastRoutedUserMessageId: string | null = null
  private lastModelRoutedFor: string | null = null
  /** The routed assistant's instructions, when it is not the default Flint. */
  routedAssistantInstructions: string | undefined
  routedAssistantId: string | undefined
  /** The mode Jev suggested for this message, or null. */
  routedMode: JevSuggestedMode | null = null
  /** The assistant picked when this session first sent. */
  private sessionAssistant: Assistant | undefined
  private sessionAssistantCaptured = false
  /** The assistant Jev routed to, kept until it routes elsewhere. */
  private routedAssistant: Assistant | undefined

  /**
   * Let Jev pick the AI model for this message, when the person turned that on.
   * Only models that can use tools are offered, and none with a known context
   * window smaller than the session model's, because the run's compaction and
   * context accounting follow the session's model.
   *
   * Null when this message was already routed. Otherwise `begin` runs first
   * (the caller drops the previous message's model there and answers with the
   * selection to route from), and the routed selection comes back, undefined
   * to keep the session's own model.
   */
  async routeModel(
    messages: UIMessage[],
    begin: () => ModelSelection,
    signal?: AbortSignal
  ): Promise<{ selection: ModelSelection | undefined } | null> {
    const latest = latestUserMessage(messages)
    if (!latest || latest.id === this.lastModelRoutedFor) return null
    this.lastModelRoutedFor = latest.id
    const current = begin()
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const routed = await routeModelForTurn({
      message: latest.text,
      parts: lastUser?.parts ?? [],
      current,
      temporary: false,
      requireTools: true,
      keepContextWindow: true,
      signal,
    })
    return { selection: routed?.selection }
  }

  /**
   * Route this message's assistant. Null when this message was already
   * routed; otherwise the assistant now answering (undefined for none).
   */
  async routePrompt(
    messages: UIMessage[],
    signal?: AbortSignal
  ): Promise<{ answering: { name: string; avatar?: string } | undefined } | null> {
    const latest = latestUserMessage(messages)
    if (!latest || latest.id === this.lastRoutedUserMessageId) return null
    this.lastRoutedUserMessageId = latest.id

    const state = useAssistant.getState()
    // This session's own assistant: what the picker held when the session
    // first sent, not whatever any other chat sets later.
    if (!this.sessionAssistantCaptured) {
      this.sessionAssistant = state.currentAssistant
      this.sessionAssistantCaptured = true
    }
    const base = this.sessionAssistant
    // Only a session on the default Flint is routed; a picked assistant (or
    // "None") stays.
    const route = await chooseJevPromptRoute({
      message: latest.text,
      assistants: state.assistants,
      currentAssistantId: base?.id,
      // Five assistants, not fifteen assistant-and-style pairs (see the chat
      // transport): the split left each pair under Jev's 0.7 bar. The work
      // profile chosen alongside already says how to approach the message.
      includeCoworkMode: false,
      pinned: !base || base.id !== 'jan',
      temporary: false,
      signal,
    })

    if (route?.assistantId) {
      this.routedAssistant = state.assistants.find(
        (assistant) => assistant.id === route.assistantId
      )
    }
    // On abstention or an unavailable Jev the assistant this session already
    // has (routed earlier, else its own) is kept.
    const selected = this.routedAssistant ?? base

    // Flint remains Cowork's baseline generalist; injecting its existing chat
    // prompt here would change the default behaviour the user asked us not to
    // edit. Any non-Flint assistant that is selected intentionally -- including
    // a custom/project assistant that Jev is not allowed to route away from --
    // contributes its persona beneath Cowork's policy.
    this.routedAssistantId = selected && selected.id !== 'jan' ? selected.id : undefined
    this.routedAssistantInstructions =
      selected && selected.id !== 'jan' ? selected.instructions : undefined
    const answering = selected?.name
      ? {
          name: selected.name,
          avatar:
            selected.id !== 'jan' && typeof selected.avatar === 'string'
              ? selected.avatar
              : undefined,
        }
      : undefined
    this.routedMode = route?.mode ?? null
    // The global assistant store is deliberately not touched: routing is per
    // session, and mirroring it there would leak into other conversations and
    // be saved as the user's "last used" assistant.
    return { answering }
  }
}
