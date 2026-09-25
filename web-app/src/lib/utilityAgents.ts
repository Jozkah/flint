/**
 * Hidden internal utility agents. AH-208.
 *
 * Titling a conversation and summarising one for compaction are model calls
 * Flint makes for itself. They run through here so that three things hold for
 * every one of them:
 *
 * - **No authority.** The call is made with no tools and `toolChoice: 'none'`,
 *   and this function has no parameter through which a tool, a grant or a
 *   write root could be passed. It cannot read a file or run a command.
 * - **Not shown as an agent.** Nothing here touches the tool timeline, the
 *   activity panel or the agent lists.
 * - **Still accountable.** Every invocation -- succeeded, failed or cancelled
 *   -- is recorded in `audit/utility-agents.jsonl` with its kind, session,
 *   model, duration and token counts. Never its prompt or its output.
 */
import { generateText, type LanguageModel, type ModelMessage } from 'ai'
import { invoke } from '@tauri-apps/api/core'

export type UtilityKind = 'title' | 'summary' | 'classify' | 'describe'

export type UtilityRequest = {
  kind: UtilityKind
  session: string
  model: LanguageModel
  /** For the record only. */
  modelId: string
  system?: string
  messages: ModelMessage[]
  maxOutputTokens: number
  abortSignal?: AbortSignal
}

let seq = 0
const nextId = () => `util-${Date.now().toString(36)}-${(seq++).toString(36)}`

function record(entry: {
  id: string
  kind: UtilityKind
  session: string
  model: string
  outcome: 'succeeded' | 'failed' | 'cancelled'
  durationMs: number
  promptTokens?: number
  completionTokens?: number
}): void {
  void invoke('utility_agent_record', {
    record: {
      v: 1,
      at: new Date().toISOString(),
      id: entry.id,
      kind: entry.kind,
      session: entry.session,
      model: entry.model,
      outcome: entry.outcome,
      durationMs: entry.durationMs,
      promptTokens: entry.promptTokens ?? null,
      completionTokens: entry.completionTokens ?? null,
      toolsOffered: false,
    },
  }).catch(() => {
    // Accounting never fails the call it describes; outside Tauri there is
    // nowhere to write.
  })
}

/**
 * Run a utility call. Resolves to the text, or throws what `generateText`
 * threw after recording it -- callers keep their own fallbacks.
 */
export async function runUtilityAgent(req: UtilityRequest): Promise<string> {
  const id = nextId()
  const started = Date.now()
  try {
    const result = await generateText({
      model: req.model,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages,
      maxOutputTokens: req.maxOutputTokens,
      abortSignal: req.abortSignal,
      // Explicit, so a default elsewhere can never hand this call a tool.
      tools: undefined,
      toolChoice: 'none',
    })
    record({
      id,
      kind: req.kind,
      session: req.session,
      model: req.modelId,
      outcome: 'succeeded',
      durationMs: Date.now() - started,
      promptTokens: result.usage?.inputTokens,
      completionTokens: result.usage?.outputTokens,
    })
    return result.text
  } catch (error) {
    const cancelled =
      req.abortSignal?.aborted || (error as Error)?.name === 'AbortError'
    record({
      id,
      kind: req.kind,
      session: req.session,
      model: req.modelId,
      outcome: cancelled ? 'cancelled' : 'failed',
      durationMs: Date.now() - started,
    })
    throw error
  }
}
