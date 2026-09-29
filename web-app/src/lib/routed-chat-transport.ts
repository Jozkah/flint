import type { UIMessage } from 'ai'
import { CustomChatTransport } from '@/lib/custom-chat-transport'
import {
  chooseJevPromptRoute,
  jevModeSuggestion,
  type JevSuggestedMode,
} from '@/lib/jevRouting'
import { useAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'
import { renderInstructions } from '@/lib/instructionTemplate'

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

  private async routeAssistant(
    messages: Parameters<CustomChatTransport['sendMessages']>[0]['messages']
  ) {
    const latest = latestUserMessage(messages)
    if (!latest || latest.id === this.lastRoutedUserMessageId) return
    this.lastRoutedUserMessageId = latest.id
    // A previous turn's advice must never leak when routing is now disabled,
    // shadowed, unavailable, or a custom assistant has been pinned.
    this.routedMode = null

    const assistantState = useAssistant.getState()
    const thread = this.threadId
      ? useThreads.getState().threads[this.threadId]
      : undefined
    const currentAssistant = thread?.assistants?.[0] ?? assistantState.currentAssistant

    const route = await chooseJevPromptRoute({
      message: latest.text,
      assistants: assistantState.assistants,
      currentAssistantId: currentAssistant?.id,
      includeCoworkMode: true,
    })
    this.routedMode = route?.mode ?? null
    if (!route?.assistantId) return

    const assistant = assistantState.assistants.find(
      (candidate) => candidate.id === route.assistantId
    )
    if (!assistant) return

    // The transport must see the routed prompt immediately. Waiting for the
    // Zustand update + React effect would send this turn with the old persona.
    this.updateSystemMessage(
      assistant.instructions
        ? renderInstructions(assistant.instructions)
        : undefined
    )

    if (this.threadId && thread) {
      useThreads.getState().updateThread(this.threadId, {
        assistants: [{ ...assistant, model: thread.model }],
      })
    }

    // Keep the switcher/default state in sync without changing the user's
    // remembered default assistant. A custom/project assistant never reaches
    // this branch; jevRouting deliberately leaves those pinned.
    assistantState.setCurrentAssistant(assistant, false)
  }

  protected override buildSystemPrompt(messages: UIMessage[]): string | undefined {
    const base = super.buildSystemPrompt(messages)
    const modeHint = jevModeSuggestion(this.routedMode)
    return [base, modeHint]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n\n') || undefined
  }

  override async sendMessages(
    options: Parameters<CustomChatTransport['sendMessages']>[0]
  ) {
    await this.routeAssistant(options.messages)
    return super.sendMessages(options)
  }
}
