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
import { useModelRouting } from '@/hooks/useModelRouting'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  chooseJevModel,
  messageNeeds,
  resolvePool,
  type ModelTarget,
} from '@/lib/jevModelRouting'
import { askToSwitchModel } from '@/lib/jevModelPrompt'
import { getProviderTitle } from '@/lib/utils'

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
/**
 * What a reply shows of the assistant that answered it. Flint keeps the Flint
 * mark, so it carries no avatar.
 */
const answeringOf = (
  a: { id?: string; name?: string; avatar?: string } | undefined
): { name: string; avatar?: string } | undefined =>
  a?.name
    ? {
        name: a.name,
        avatar:
          a.id !== 'jan' && typeof a.avatar === 'string' ? a.avatar : undefined,
      }
    : undefined

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
      this.routeModelFor(latest, messages, signal),
    ])
    this.activeSkills = skills
  }

  /**
   * Let Jev pick the AI model for this message, when the person turned that on
   * and listed the models it may pick from. Most messages stay on the current
   * model: Jev names another only when it is clearly better, and in Ask mode
   * the person is asked first. The choice is for this message only and the
   * model picker is left alone. A temporary chat never sends its prompt to Jev.
   */
  private async routeModelFor(
    latest: { id: string; text: string },
    messages: Parameters<CustomChatTransport['sendMessages']>[0]['messages'],
    signal?: AbortSignal
  ) {
    // Last message's choice must never carry over.
    this.turnModel = undefined
    const routing = useModelRouting.getState()
    if (routing.mode === 'off' || routing.pool.length === 0 || this.temporary) return
    // Jev's own opt-in governs whether anything may be asked.
    if (useJevSettings.getState().skillMode !== 'on') return

    const providers = useModelProvider.getState().providers
    const pool = resolvePool(routing.pool, providers)
    const thread = this.threadId ? useThreads.getState().threads[this.threadId] : undefined

    // A regenerate after a restart keeps what this message was routed to.
    const kept = thread?.metadata?.jevRoutedModel as
      | { messageId?: string; provider?: string; model?: string }
      | undefined
    if (kept?.messageId === latest.id && kept.provider && kept.model) {
      const target = pool.find((m) => m.provider === kept.provider && m.model === kept.model)
      if (target) this.turnModel = this.selectionFor(target)
      return
    }

    const { selectedProvider, selectedModel } = this.getModelSelection()
    if (!selectedProvider || !selectedModel) return
    const currentProvider = providers.find((p) => p.provider === selectedProvider)
    const current = {
      provider: selectedProvider,
      model: selectedModel.id,
      label: `${currentProvider?.displayName || getProviderTitle(selectedProvider)} / ${selectedModel.displayName || selectedModel.id}`,
      local: selectedProvider === 'llamacpp' || selectedProvider === 'mlx',
      capabilities: selectedModel.capabilities ?? [],
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const decision = await chooseJevModel({
      message: latest.text,
      current,
      pool,
      needs: messageNeeds(lastUser?.parts ?? [], current.capabilities),
      signal,
    })
    const target = decision?.target
    if (!target) return
    if (routing.mode === 'ask') {
      const accepted = await askToSwitchModel({
        currentLabel: current.label,
        targetLabel: target.label,
        signal,
      })
      if (!accepted) return
    }
    this.turnModel = this.selectionFor(target)
    if (this.threadId && thread) {
      useThreads.getState().updateThread(this.threadId, {
        metadata: {
          ...thread.metadata,
          jevRoutedModel: { messageId: latest.id, provider: target.provider, model: target.model },
        },
      })
    }
  }

  /** The picker-shaped selection for a routed model, from the provider's own model entry. */
  private selectionFor(target: ModelTarget) {
    const provider = useModelProvider.getState().providers.find((p) => p.provider === target.provider)
    const model = provider?.models.find((m) => m.id === target.model)
    return model ? { selectedProvider: target.provider, selectedModel: model } : undefined
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
    if (thread?.metadata?.jevRoutedMessageId === latest.id) {
      this.answeringAssistant = answeringOf(thread.assistants?.[0])
      return
    }

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
    // Named on the reply: the one just routed to, else the one in charge.
    this.answeringAssistant = answeringOf(assistant ?? current)
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
