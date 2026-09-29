import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { useAssistant } from '@/hooks/useAssistant'
import type { Tool, UIMessage } from 'ai'
import { CustomChatTransport } from '@/lib/custom-chat-transport'
import { COWORK_SLOT_ID } from '@/constants/models'
import { sandboxEnforces } from '@/lib/agentTools'
import {
  chooseJevPromptRoute,
  jevModeSuggestion,
  type JevSuggestedMode,
} from '@/lib/jevRouting'
import {
  buildCoworkTools,
  coworkToolSignature,
  type CoworkToolOptions,
} from '@/lib/coworkTools'
import {
  buildCoworkSystemPrompt,
  environmentOptions,
  type CoworkEnvironmentOptions,
  type PromptFolderAccess,
} from '@/lib/coworkPrompt'
import { measureContextPack } from '@/lib/coworkContext'
import type { ContextAccounting } from '@/lib/coworkReadiness'
import { useModelProvider } from '@/hooks/useModelProvider'

export type CoworkRunConfig = CoworkToolOptions & CoworkEnvironmentOptions & {
  /**
   * The model this run is sent with, captured from its session when the run
   * started (janhq/jan#8905). Every step of the run uses it, whatever the
   * global picker says by then; absent, the global selection is used.
   */
  model?: { provider: string; id: string }
  workspacePath: string | null
  readOnlyFolder: string | null
  /** The session's additional attached folders, frozen with the run. */
  extraFolders?: readonly string[]
  /** Whether this run's write grant covers `extraFolders`. */
  extraFoldersWritable?: boolean
  /**
   * Whether this run may write to the attached folder.
   *
   * Frozen with the run, from its effective access — so the prompt describes
   * the destination the dispatcher will actually use.
   */
  folderAccess?: PromptFolderAccess
  /** The managed worktree's own branch, when `folderAccess` is `worktree`. */
  worktreeBranch?: string | null
  /** The attached project's git branch, surfaced in the system prompt. */
  gitBranch?: string | null
  /** Verbatim `JAN.md` from the attached folder, when it has one. */
  projectInstructions?: string | null
  /**
   * Compatibility instructions the resolver made active for this run.
   *
   * Frozen with the run like everything else here: configuration edited while
   * a run is going applies to the next one.
   */
  compatInstructions?: readonly { name: string; content: string }[]
  /** The backend's project tooling block, frozen with the run. */
  projectTooling?: string | null
  /**
   * The opening turn reads and proposes rather than acting.
   *
   * Decided per request from what the user typed, and frozen with the run like
   * everything else here.
   */
  openingInspection?: boolean
}

function latestUserMessage(messages: UIMessage[]): { id: string; text: string } | null {
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
 * The chat transport, re-aimed at an agent run.
 *
 * Everything expensive is inherited: model creation and its abort-during-load
 * unload, the sampling/reasoning merge, attachment encoding, tool-call repair,
 * and the usage metadata. Only four things differ, and each is a seam on the
 * parent.
 */
export class CoworkChatTransport extends CustomChatTransport {
  /** The route records uses where the turn meets its snapshot (AH-083). */
  protected override recordsMemoryUsesOnFinish = false
  /** The Cowork run records every step; a chat run would duplicate it. */
  protected override recordsChatRun = false
  // The run loop compacts, and persists the summary; see `runTurn`'s `compact`.
  protected override compactsAtThreshold = false

  /**
   * JAN.md and the approved compatibility files: the instruction text above
   * memory in this run (AH-084). Exactly what the prompt carries, so a memory
   * is withheld only for disagreeing with something the model is told.
   */
  protected override memoryInstructions() {
    const out: { source: 'jan-md' | 'compat' | 'skill'; name: string; text: string }[] = []
    const jan = this.config.projectInstructions?.trim()
    if (jan) out.push({ source: 'jan-md', name: 'FLINT.md', text: jan })
    for (const one of this.config.compatInstructions ?? []) {
      if (one.content.trim()) out.push({ source: 'compat', name: one.name, text: one.content })
    }
    return out
  }
  private config: CoworkRunConfig
  /**
   * The advertised tool set, frozen for a run's lifetime.
   *
   * An agent turn calls `sendMessages` many times, and any change to the tool
   * JSON changes the prompt prefix, discarding the KV cache on every step. A
   * mode change therefore applies at the next message, not mid-run.
   */
  private frozenTools: Record<string, Tool> | null = null
  /** Last set actually built, kept across runs so an unchanged config does not
   * pay for a rebuild at every run boundary. */
  private builtTools: Record<string, Tool> | null = null
  private builtSig = ''
  /** One Jev route per user turn, never one per tool-loop step. */
  private lastRoutedUserMessageId: string | null = null
  /** Persona selected for this turn. Flint keeps Cowork's existing baseline. */
  private routedAssistantInstructions: string | undefined
  /** Behavioural suggestion only; never used by the permission gate. */
  private routedMode: JevSuggestedMode | null = null

  constructor(sessionId: string, config: CoworkRunConfig) {
    super(undefined, sessionId)
    this.config = config
  }

  /**
   * The run's own model, not the global selection.
   *
   * The parent read the global picker on every step, so choosing a model in
   * another session -- or in this one mid-run -- changed the model of a run
   * already under way. A model its provider no longer offers is reported as
   * none rather than silently replaced by whatever is selected.
   */
  protected override getModelSelection() {
    const chosen = this.config.model
    if (!chosen) return super.getModelSelection()
    const provider = useModelProvider.getState().getProviderByName(chosen.provider)
    return {
      selectedProvider: chosen.provider,
      selectedModel:
        (provider?.active === false
          ? undefined
          : provider?.models.find((model) => model.id === chosen.id)) ?? null,
    }
  }

  /**
   * Set for one request: the closing turn after the loop guard stopped a run,
   * which may answer but not call tools. The tools stay advertised so the
   * prompt prefix is the same as every other step's.
   */
  textOnlyNext = false

  protected override toolChoiceForStep(): 'auto' | 'none' {
    if (this.textOnlyNext) {
      this.textOnlyNext = false
      return 'none'
    }
    return 'auto'
  }

  /** Applied at the next run: changing it mid-run would invalidate the prefix. */
  setConfig(config: CoworkRunConfig) {
    this.config = config
  }

  /** Drop the freeze so the next run re-reads the config. */
  unfreezeTools() {
    this.frozenTools = null
  }

  /**
   * The set actually advertised this run, for narrowing a subagent's tools.
   *
   * A child's allowlist intersects with this rather than with the full built-in
   * list, so plan mode and a withheld `bash` propagate to children for free.
   */
  get advertisedTools(): Record<string, Tool> {
    return this.frozenTools ?? this.tools
  }

  /** Cowork gets its own llama.cpp slot: sharing chat's would evict the viewed
   * thread's prefix on every one of this turn's many prefills, and vice versa. */
  protected override slotParams(threadId?: string): Record<string, unknown> {
    return { id_slot: COWORK_SLOT_ID, thread_id: `cowork:${threadId ?? ''}` }
  }

  /**
   * Project memory follows the folder attached to the run.
   *
   * Not `workspacePath`: that is this session's own sandbox, and keying
   * project memory to it would make every "project" memory belong to one
   * session. With no folder attached there is no project, and only chat and
   * across-chat memories apply.
   */
  protected override syncMemoryBinding(): void {
    this.setMemoryBinding({
      projectRoot: this.config.readOnlyFolder ?? undefined,
      temporary: false,
    })
  }

  private async routePrompt(messages: UIMessage[]) {
    const latest = latestUserMessage(messages)
    if (!latest || latest.id === this.lastRoutedUserMessageId) return
    this.lastRoutedUserMessageId = latest.id

    const state = useAssistant.getState()
    const route = await chooseJevPromptRoute({
      message: latest.text,
      assistants: state.assistants,
      currentAssistantId: state.currentAssistant?.id,
      includeCoworkMode: true,
    })

    const selected = route?.assistantId
      ? state.assistants.find((assistant) => assistant.id === route.assistantId)
      : state.currentAssistant

    // Flint remains Cowork's baseline generalist; injecting its existing chat
    // prompt here would change the default behaviour the user asked us not to
    // edit. Any non-Flint assistant that is selected intentionally — including
    // a custom/project assistant that Jev is not allowed to route away from —
    // contributes its persona beneath Cowork's policy.
    this.routedAssistantInstructions =
      selected && selected.id !== 'jan' ? selected.instructions : undefined
    this.routedMode = route?.mode ?? null

    if (route?.assistantId && selected) {
      // Sync the picker for the next turn, but do not replace the user's saved
      // default assistant. Routing is per prompt.
      state.setCurrentAssistant(selected, false)
    }
  }

  override async sendMessages(
    options: Parameters<CustomChatTransport['sendMessages']>[0]
  ) {
    await this.routePrompt(options.messages)
    return super.sendMessages(options)
  }

  /**
   * Cowork's own prompt replaces the chat one wholesale — the agent-tools and
   * web-search blurbs are written for a chat that occasionally reaches for a
   * tool, not for a run whose whole purpose is tool use. The attached-files
   * instruction is kept: a pasted document is otherwise never explained.
   *
   * Remembered facts go after the policy and project instructions, never
   * above them: the block labels itself as facts rather than instructions,
   * and its position says the same thing -- nothing remembered outranks the
   * run's rules or JAN.md.
   */
  protected override buildSystemPrompt(messages: UIMessage[]): string {
    const base = buildCoworkSystemPrompt({
      availableTools: Object.keys(this.advertisedTools),
      workspacePath: this.config.workspacePath,
      readOnlyFolder: this.config.readOnlyFolder,
      extraFolders: this.config.extraFolders,
      extraFoldersWritable: this.config.extraFoldersWritable,
      folderAccess: this.config.folderAccess,
      worktreeBranch: this.config.worktreeBranch,
      ...environmentOptions(this.config),
      gitBranch: this.config.gitBranch,
      projectInstructions: this.config.projectInstructions,
      compatInstructions: this.config.compatInstructions,
      projectTooling: this.config.projectTooling,
      planMode: this.config.planMode,
      openingInspection: this.config.openingInspection,
      bashAvailable: sandboxEnforces(),
      subagentNames: this.config.allowSubagents ? this.config.subagentNames : [],
      webSearch: this.config.webSearch,
      workProfileBlock: useWorkProfiles.getState().blockFor(this.threadId),
    })
    const assistantProfile = this.routedAssistantInstructions?.trim()
      ? [
          'Assistant profile for this turn (behaviour only; Cowork policy, permissions, and project instructions above take precedence):',
          this.routedAssistantInstructions.trim(),
        ].join('\n')
      : undefined
    const modeHint = jevModeSuggestion(this.routedMode)
    // Remembered facts come after everything that states policy -- the run's
    // own rules, `JAN.md`, the compatibility instructions -- and the block
    // labels itself as data rather than instructions. Omitting it, as this
    // override used to, meant Cowork retrieved memory on every turn and then
    // never sent any of it.
    return [
      base,
      assistantProfile,
      modeHint,
      this.memorySelection?.block ? this.memorySelection.precedence : undefined,
      this.memorySelection?.block,
      this.buildFilesSystemInstruction(messages),
    ]
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .join('\n\n')
  }

  /**
   * What this run will actually send, measured by category.
   *
   * Deliberately a method on the transport rather than a calculation the card
   * does for itself. The card and the run would otherwise each assemble their
   * own idea of the payload and drift apart, which is the failure the readiness
   * manifest exists to prevent — so the number comes from the same
   * `buildSystemPrompt` and the same `advertisedTools` that the request is
   * built from, and cannot describe a run that is not happening.
   */
  measureContext(
    messages: UIMessage[],
    configuredContextTokens?: number | null
  ): ContextAccounting {
    return measureContextPack({
      systemPrompt: this.buildSystemPrompt(messages),
      toolSchemas: this.advertisedTools,
      messages,
      configuredContextTokens,
    })
  }

  /**
   * An agent run legitimately reaches a window whose only user turn is far
   * back, and tool results are the recent traffic. The parent's guard exists
   * for chat, where a window with no user turn means eviction ate the question;
   * here it would abort a healthy long run.
   */
  protected override assertSendable(): void {}

  override async refreshTools(): Promise<void> {
    // Frozen means frozen: once a run is under way the advertised set is fixed
    // even if the config changed, because rebuilding it would change the tool
    // JSON and discard the prompt prefix on the next of this turn's many
    // prefills. `unfreezeTools()` at the run boundary is what lets it move.
    if (this.frozenTools) {
      this.tools = this.frozenTools
      return
    }
    const sig = coworkToolSignature(this.config, sandboxEnforces())
    // Between runs, skip the rebuild when nothing that shapes the set changed.
    if (this.builtTools && this.builtSig === sig) {
      this.frozenTools = this.builtTools
      this.tools = this.builtTools
      return
    }
    const tools = await buildCoworkTools(this.config)
    this.builtTools = tools
    this.builtSig = sig
    this.frozenTools = tools
    this.tools = tools
  }
}
