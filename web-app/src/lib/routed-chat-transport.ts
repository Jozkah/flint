import type { UIMessage } from 'ai'
import { CustomChatTransport } from '@/lib/custom-chat-transport'
import {
  chooseJevPromptRoute,
  jevModeSuggestion,
  type JevSuggestedMode,
} from '@/lib/jevRouting'
import { useAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'
import { useJevSettings } from '@/hooks/useJevSettings'
import { renderInstructions } from '@/lib/instructionTemplate'
import { chooseWorkProfile, useWorkProfiles } from '@/hooks/useWorkProfiles'
import { workProfileAsker } from '@/lib/jev'
import {
  resolveSkillActivation,
  skillActivationBlock,
  type ActivatedSkill,
} from '@/lib/skillActivation'
import { refreshSkillCatalog } from '@/lib/skillCatalog'

function latestUserMessage(
  messages: Parameters<CustomChatTransport['sendMessages']>[0]['messages']
): { id: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const text = message.parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return { id: message.id, text }
  }
  return null
}

/**
 * Ordinary Chat transport with one extra pre-dispatch step: when a new user
 * turn appears, Jev may select Flint/Quartz/Coal/Blaze/Redstone and an
 * advisory Review/Ask/Auto work style for that turn. Tool follow-ups and
 * regenerations keep the same selection because their latest user-message id
 * has not changed.
 */
export class RoutedChatTransport extends CustomChatTransport {
  private lastRoutedUserMessageId: string | null = null
  private routedMode: JevSuggestedMode | null = null
  private activeSkills: ActivatedSkill[] = []

  /**
   * Everything that has to be decided before this message is sent, run side by
   * side: the skills that apply, the work profile, and the assistant route.
   * They are independent, and each may wait on Jev, so waiting for them one
   * after another would add their delays together; together the wait is the
   * slowest one, and with Jev off none of them touches the network.
   */
  private async routeAssistant(
    messages: Parameters<CustomChatTransport['sendMessages']>[0]['messages'],
    signal?: AbortSignal
  ) {
    const latest = latestUserMessage(messages)
    if (!latest || latest.id === this.lastRoutedUserMessageId) return
    this.lastRoutedUserMessageId = latest.id
    // A previous turn's advice must never leak when routing is now disabled,
    // shadowed, unavailable, or a custom assistant has been pinned.
    this.routedMode = null

    const [skills] = await Promise.all([
      // Skills that apply to this message (always-active, triggered, or Jev's
      // pick), read now so the prompt built later carries their instructions.
      refreshSkillCatalog()
        .then(() =>
          resolveSkillActivation({ text: latest.text, temporary: this.temporary, signal })
        )
        // Routing is help, never a reason to fail the user's prompt.
        .catch((): ActivatedSkill[] => []),
      // Work profiles (off unless the user turned them on): the new message
      // picks how this conversation approaches it -- Jev decides when its
      // suggestions are on, a keyword match otherwise, a profile picked by hand
      // is kept. A temporary chat never sends its prompt to Jev.
      this.threadId
        ? chooseWorkProfile(
            this.threadId,
            latest.text,
            this.temporary ? undefined : workProfileAsker(useJevSettings.getState().rerankMode)
          ).catch(() => undefined)
        : Promise.resolve(undefined),
      this.routeAssistantFor(latest, signal),
    ])
    this.activeSkills = skills
  }

  private async routeAssistantFor(
    latest: { id: string; text: string },
    signal?: AbortSignal
  ) {
    const assistantState = useAssistant.getState()
    const thread = this.threadId
      ? useThreads.getState().threads[this.threadId]
      : undefined
    // A regenerate after a restart: this message was already routed, so keep
    // what that decided instead of asking again and possibly picking another.
    if (thread?.metadata?.jevRoutedMessageId === latest.id) return

    // Only a conversation still on the default is auto-routed. An assistant the
    // user set (Coal, Quartz, a custom one) or "None" stays. The one built-in
    // that is not the user's choice is the one Jev itself applied earlier.
    const routedId = thread?.metadata?.jevRoutedAssistantId
    const current =
      thread?.assistants?.[0] ??
      (thread?.assistants ? undefined : assistantState.currentAssistant)
    const pinned = !current || (current.id !== 'jan' && current.id !== routedId)

    const route = await chooseJevPromptRoute({
      message: latest.text,
      assistants: assistantState.assistants,
      currentAssistantId: current?.id,
      // Five assistants, not fifteen assistant-and-style pairs: Jev answers
      // with one probability per choice and abstains below 0.7, so splitting
      // the same prompt three ways left each pair under the bar and Flint was
      // kept. A chat has no Cowork style to advise anyway; its work profile is
      // chosen separately.
      includeCoworkMode: false,
      pinned,
      temporary: this.temporary,
      signal,
    })
    this.routedMode = route?.mode ?? null

    const assistant = route?.assistantId
      ? assistantState.assistants.find(
          (candidate) => candidate.id === route.assistantId
        )
      : undefined
    if (assistant && assistant.id !== current?.id) {
      // The transport must see the routed prompt immediately. Waiting for the
      // Zustand update + React effect would send this turn with the old persona.
      this.updateSystemMessage(
        assistant.instructions
          ? renderInstructions(assistant.instructions)
          : undefined
      )
    }

    // Remember the message, so a regenerate never re-routes it. The global
    // assistant store is left alone: routing is per conversation, and mirroring
    // it there would leak into other chats and be saved as "last used".
    if (this.threadId && thread && useJevSettings.getState().skillMode !== 'off') {
      useThreads.getState().updateThread(this.threadId, {
        ...(assistant && assistant.id !== current?.id
          ? { assistants: [{ ...assistant, model: thread.model }] }
          : {}),
        metadata: {
          ...thread.metadata,
          jevRoutedMessageId: latest.id,
          ...(assistant ? { jevRoutedAssistantId: assistant.id } : {}),
        },
      })
    }
  }

  protected override skillTextsInPrompt(): string[] {
    return [...super.skillTextsInPrompt(), skillActivationBlock(this.activeSkills)]
  }

  protected override buildSystemPrompt(messages: UIMessage[]): string | undefined {
    const base = super.buildSystemPrompt(messages)
    const modeHint = jevModeSuggestion(this.routedMode)
    const profile = useWorkProfiles.getState().blockFor(this.threadId)
    return [base, profile, skillActivationBlock(this.activeSkills), modeHint]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n\n') || undefined
  }

  override async sendMessages(
    options: Parameters<CustomChatTransport['sendMessages']>[0]
  ) {
    await this.routeAssistant(options.messages, options.abortSignal)
    return super.sendMessages(options)
  }
}
