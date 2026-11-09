import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import type { ParentPersona } from '@/lib/subagentChoice'
import type { Tool, UIMessage } from 'ai'
import { CustomChatTransport } from '@/lib/custom-chat-transport'
import { COWORK_SLOT_ID } from '@/constants/models'
import { AGENT_TOOL_NAMES, sandboxEnforces } from '@/lib/agentTools'
import { applyWebSearchToTools, buildCoworkTools, coworkToolSignature } from '@/lib/coworkTools'
import { groupOf, withoutEnable, type ToolGroupId } from '@/lib/coworkToolGroups'
import { refreshSkillCatalog, skillCatalogBlock } from '@/lib/skillCatalog'
import {
  latestUserText,
  resolveSkillActivation,
  skillActivationBlock,
  type ActivatedSkill,
} from '@/lib/skillActivation'
import { measureContextPack } from '@/lib/coworkContext'
import type { ContextAccounting } from '@/lib/coworkReadiness'
import { useModelProvider } from '@/hooks/useModelProvider'
import { lastUserText } from '@/lib/coworkTransportMessages'
import type { CoworkRunConfig } from '@/lib/coworkRunConfig'
import {
  advertisedGroupsOf,
  composeFrozenTools,
  configWithSkillGroups,
  heldBackToolsOf,
  heldGroupsOf,
  leanBuiltinTools,
  memoryInstructionsOf,
} from '@/lib/coworkTransportTools'
import { CoworkPromptRouter } from '@/lib/coworkPromptRouting'
import { coworkRunPrompt } from '@/lib/coworkRunPrompt'
import { loadCoworkMcpOverlay } from '@/lib/coworkMcpOverlay'

export type { CoworkRunConfig }
export { lastUserText }

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
    return memoryInstructionsOf(this.config)
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
  /**
   * Specialist tools this run is not advertising (`coworkToolGroups.ts`), and
   * the groups `enable_tools` has opened since. Opening one is the only thing
   * that changes the frozen set mid-run.
   */
  private heldTools: Record<string, Tool> = {}
  private builtHeld: Record<string, Tool> = {}
  private openGroups = new Set<ToolGroupId>()
  /**
   * MCP tools of the servers that are on right now, re-read at every request.
   * Kept apart from `frozenTools`: the built-in set stays frozen for the run,
   * and this changes only when a server connects, disconnects or is switched.
   */
  private mcpOverlay: Record<string, Tool> = {}
  private mcpToolServers = new Map<string, string>()
  private mcpStarting: string[] = []
  private mcpWithheldLabels: string[] = []
  /** False until a request has read the live set: an estimate states no line. */
  private mcpRead = false
  private advertised: Record<string, Tool> | null = null
  /** Skills that apply to the latest user message, and which message that was. */
  private activeSkills: ActivatedSkill[] = []
  private activatedFor: string | null = null
  /** Last set actually built, kept across runs so an unchanged config does not
   * pay for a rebuild at every run boundary. */
  private builtTools: Record<string, Tool> | null = null
  private builtSig = ''
  /** Jev's model and assistant for each user message (see CoworkPromptRouter). */
  private readonly router = new CoworkPromptRouter()

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
    // The model Jev routed this message to, for this message only.
    if (this.turnModel) return this.turnModel
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

  /** Cowork gates by tool group and `enable_tools`; chat's triggers do not apply. */
  protected override appliesChatToolGating(): boolean {
    return false
  }

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

  /**
   * A Settings toggle (web search) mid-run.
   *
   * Settings apply at the next run, like a mode change: the advertised set is
   * frozen for a run's lifetime, so the toggle must not rebuild it. The web
   * tools are the only part of the set a Settings toggle touches, so they are
   * added to or removed from the frozen record in place, and the next run
   * re-reads the setting from scratch.
   */
  setWebSearch(webSearch: boolean) {
    this.config = { ...this.config, webSearch }
    if (this.frozenTools) {
      this.frozenTools = applyWebSearchToTools(this.frozenTools, webSearch)
      this.tools = this.frozenTools
    }
  }

  /** Drop the freeze so the next run re-reads the config. */
  unfreezeTools() {
    this.frozenTools = null
    this.heldTools = {}
    this.openGroups = new Set()
  }

  /** Held groups with a tool present that nothing has opened yet. */
  get heldGroups(): ToolGroupId[] {
    return heldGroupsOf(this.heldTools, this.openGroups)
  }

  /** Groups with a tool in the advertised set right now (started with, or opened). */
  get advertisedGroups(): ReadonlySet<ToolGroupId> {
    return advertisedGroupsOf(this.frozenTools ?? this.tools)
  }

  get openedGroups(): ReadonlySet<ToolGroupId> {
    return this.openGroups
  }

  /** The held-back tools, for the context popover. */
  get heldBackTools(): { name: string; group: ToolGroupId; schema: unknown }[] {
    return heldBackToolsOf(this.heldTools, this.openGroups)
  }

  /**
   * `enable_tools`: advertise held groups from the next request on.
   *
   * Appended after the frozen tools, so the prompt prefix up to them is kept;
   * what follows is re-read once, and the set is then frozen again for the rest
   * of the run. Not a permission: an opened tool is gated exactly as before.
   */
  openGroupsNow(groups: readonly ToolGroupId[]): string[] {
    const added: string[] = []
    for (const id of groups) {
      if (this.openGroups.has(id)) continue
      this.openGroups.add(id)
      for (const name of Object.keys(this.heldTools)) {
        if (groupOf(name) === id) added.push(name)
      }
    }
    if (added.length > 0 && this.frozenTools) {
      this.frozenTools = this.composeFrozen(this.frozenTools)
      this.tools = this.frozenTools
    }
    return added
  }

  /** Lean set plus opened groups, with `enable_tools` last (or gone when none is held). */
  private composeFrozen(base: Record<string, Tool>): Record<string, Tool> {
    return composeFrozenTools(base, this.heldTools, this.openGroups)
  }

  /**
   * Everything a subagent may be narrowed from: the advertised built-ins plus
   * the held-back ones. A child gets its own request, so nothing is lost to it
   * by the lean parent, and it never sees `enable_tools`.
   */
  get childToolSet(): Record<string, Tool> {
    return { ...withoutEnable(this.frozenTools ?? this.tools), ...this.heldTools }
  }

  /** The held-back tools, measured by the base class's breakdown. */
  protected override heldBackForBreakdown() {
    return this.heldBackTools
  }

  /**
   * The set actually advertised this run, for narrowing a subagent's tools.
   *
   * A child's allowlist intersects with this rather than with the full built-in
   * list, so plan mode and a withheld `bash` propagate to children for free.
   */
  get advertisedTools(): Record<string, Tool> {
    return this.advertised ?? this.frozenTools ?? this.tools
  }

  /** The set without MCP tools: what a subagent may be narrowed from. */
  get builtinTools(): Record<string, Tool> {
    return this.frozenTools ?? this.tools
  }

  /** The MCP server an advertised tool belongs to; undefined for any other tool. */
  mcpServerFor(toolName: string): string | undefined {
    return this.mcpToolServers.get(toolName)
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

  /**
   * Jev's model for this message, for this message only: the previous
   * message's choice is dropped before the new one is asked for.
   */
  private async routeModel(messages: UIMessage[], signal?: AbortSignal) {
    const routed = await this.router.routeModel(
      messages,
      () => {
        this.turnModel = undefined
        return this.getModelSelection()
      },
      signal
    )
    if (routed) this.turnModel = routed.selection
  }

  /** Jev's assistant for this message; it names this session's replies. */
  private async routePrompt(messages: UIMessage[], signal?: AbortSignal) {
    const routed = await this.router.routePrompt(messages, signal)
    if (routed) this.answeringAssistant = routed.answering
  }

  /** The assistant and work profile this run is using, for subagents that inherit them. */
  persona(): ParentPersona {
    const profiles = useWorkProfiles.getState()
    return {
      assistantId: this.router.routedAssistantId,
      assistantName: this.answeringAssistant?.name,
      assistantInstructions: this.router.routedAssistantInstructions,
      workProfile: profiles.enabled && this.threadId ? profiles.sessions[this.threadId]?.id : undefined,
    }
  }

  /** The assistant answering this session's turns, for naming its replies. */
  answering(): { name: string; avatar?: string } | undefined {
    return this.answeringAssistant
  }

  override async sendMessages(
    options: Parameters<CustomChatTransport['sendMessages']>[0]
  ) {
    await Promise.all([
      this.routePrompt(options.messages, options.abortSignal),
      this.routeModel(options.messages, options.abortSignal),
    ])
    // Read before the prompt is assembled, which names the installed skills
    // from this cache.
    // Which skills apply to this message, with their instructions, so the
    // prompt built below carries them. A tool follow-up inside the same run
    // keeps the set: the latest user message has not changed, so nothing is
    // fetched again.
    const latest = latestUserText(options.messages)
    if (latest && latest.id !== this.activatedFor) {
      this.activatedFor = latest.id
      try {
        await refreshSkillCatalog(this.config.readOnlyFolder)
        this.activeSkills = await resolveSkillActivation({
          folder: this.config.readOnlyFolder,
          text: latest.text,
          signal: options.abortSignal,
        })
      } catch {
        // Help, never a reason to fail the prompt.
        this.activeSkills = []
      }
    }
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
  protected override skillTextsInPrompt(): string[] {
    return [
      skillCatalogBlock(undefined, this.config.readOnlyFolder),
      skillActivationBlock(this.activeSkills),
    ]
  }

  /** The system prompt this run sends, for a forked subagent to start from. */
  forkSystemPrompt(messages: UIMessage[]): string {
    return this.buildSystemPrompt(messages)
  }

  protected override buildSystemPrompt(messages: UIMessage[]): string {
    const base = coworkRunPrompt({
      messages,
      threadId: this.threadId,
      config: this.config,
      availableTools: Object.keys(this.advertisedTools),
      mcp: {
        read: this.mcpRead,
        servers: this.mcpToolServers,
        starting: this.mcpStarting,
        withheldLabels: this.mcpWithheldLabels,
      },
      activeSkills: this.activeSkills,
      routedAssistantInstructions: this.router.routedAssistantInstructions,
      routedMode: this.router.routedMode,
    })
    // Remembered facts come after everything that states policy -- the run's
    // own rules, `JAN.md`, the compatibility instructions -- and the block
    // labels itself as data rather than instructions. Omitting it, as this
    // override used to, meant Cowork retrieved memory on every turn and then
    // never sent any of it.
    return [
      base,
      ...this.mcpPromptNotes(),
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

  /** `read` returns images; send them to the model as images, never as base64 text. */
  protected override hoistsToolImages(): boolean {
    return true
  }

  override async refreshTools(): Promise<void> {
    await this.refreshBuiltins()
    await this.refreshMcp()
  }

  /**
   * The MCP tools to offer on this request, read live.
   *
   * Review mode withholds them: nothing says an MCP tool only reads. A call
   * still goes through the approval prompt (see `dispatchCoworkTool`).
   */
  private async refreshMcp(): Promise<void> {
    const base = this.frozenTools ?? this.tools
    this.mcpStarting = []
    this.mcpStartingText = null
    this.mcpWithheldLabels = []
    this.mcpRead = true
    const { overlay, servers } = await loadCoworkMcpOverlay(base, this.config.planMode, {
      starting: (names) => {
        this.mcpStarting = names
      },
      withheldLabels: (labels) => {
        this.mcpWithheldLabels = labels
      },
      startingText: (text) => {
        this.mcpStartingText = text
      },
      record: (offered, listed) => this.recordMcpSet(offered, listed),
    })
    // Sorted, and after the built-ins: an unchanged set sends identical JSON.
    this.mcpOverlay = overlay
    this.mcpToolServers = servers
    this.advertised =
      Object.keys(this.mcpOverlay).length > 0
        ? { ...base, ...this.mcpOverlay }
        : null
    this.tools = this.advertised ?? base
  }

  private async refreshBuiltins(): Promise<void> {
    // Frozen means frozen: once a run is under way the advertised set is fixed
    // even if the config changed, because rebuilding it would change the tool
    // JSON and discard the prompt prefix on the next of this turn's many
    // prefills. `unfreezeTools()` at the run boundary is what lets it move.
    if (this.frozenTools) {
      this.tools = this.frozenTools
      return
    }
    const config = configWithSkillGroups(this.config, this.activeSkills)
    const sig = coworkToolSignature(config, sandboxEnforces())
    // Between runs, skip the rebuild when nothing that shapes the set changed.
    if (this.builtTools && this.builtSig === sig) {
      this.heldTools = this.builtHeld
      this.openGroups = new Set()
      this.frozenTools = this.builtTools
      this.tools = this.builtTools
      return
    }
    const built = await buildCoworkTools(config)
    const split = leanBuiltinTools(built, config)
    const tools: Record<string, Tool> = split.tools
    // No built-in at all means the backend list failed to load. Use it for this
    // turn but do not freeze or cache it, so the next turn asks again instead
    // of keeping a run without file or messaging tools until restart.
    if (!Object.keys(tools).some((name) => AGENT_TOOL_NAMES.has(name))) {
      this.tools = tools
      return
    }
    this.builtTools = tools
    this.builtHeld = split.held
    this.builtSig = sig
    this.heldTools = split.held
    this.openGroups = new Set()
    this.frozenTools = tools
    this.tools = tools
  }
}
