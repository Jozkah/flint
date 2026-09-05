import type { Tool, UIMessage } from 'ai'
import { CustomChatTransport } from '@/lib/custom-chat-transport'
import { COWORK_SLOT_ID } from '@/constants/models'
import { sandboxEnforces } from '@/lib/agentTools'
import {
  buildCoworkTools,
  coworkToolSignature,
  type CoworkToolOptions,
} from '@/lib/coworkTools'
import { buildCoworkSystemPrompt } from '@/lib/coworkPrompt'
import { measureContextPack } from '@/lib/coworkContext'
import type { ContextAccounting } from '@/lib/coworkReadiness'

export type CoworkRunConfig = CoworkToolOptions & {
  workspacePath: string | null
  readOnlyFolder: string | null
  /**
   * Whether this run may write to the attached folder.
   *
   * Frozen with the run, from its effective access — so the prompt describes
   * the destination the dispatcher will actually use.
   */
  folderAccess?: 'read-only' | 'editable'
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

  constructor(sessionId: string, config: CoworkRunConfig) {
    super(undefined, sessionId)
    this.config = config
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
   * Cowork's own prompt replaces the chat one wholesale — the agent-tools and
   * web-search blurbs are written for a chat that occasionally reaches for a
   * tool, not for a run whose whole purpose is tool use. The attached-files
   * instruction is kept: a pasted document is otherwise never explained.
   */
  protected override buildSystemPrompt(messages: UIMessage[]): string {
    const base = buildCoworkSystemPrompt({
      workspacePath: this.config.workspacePath,
      readOnlyFolder: this.config.readOnlyFolder,
      folderAccess: this.config.folderAccess,
      gitBranch: this.config.gitBranch,
      projectInstructions: this.config.projectInstructions,
      compatInstructions: this.config.compatInstructions,
      planMode: this.config.planMode,
      bashAvailable: sandboxEnforces(),
      subagentNames: this.config.allowSubagents ? this.config.subagentNames : [],
      webSearch: this.config.webSearch,
    })
    const files = this.buildFilesSystemInstruction(messages)
    return files.trim().length > 0 ? `${base}\n\n${files}` : base
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
