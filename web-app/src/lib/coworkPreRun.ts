/**
 * The session details' pre-run token estimate. Pure: no backend call, no MCP
 * server, no grant, no probe.
 *
 * Built from the same pieces the run uses -- `buildCoworkSystemPrompt` for the
 * system prompt with the project instructions in it, `coworkToolsFromSchemas`
 * for the tool set, and the same estimator (`estimatePreRunContext`) -- so the
 * number before the run and the run's own measurement come from one method.
 * The backend's built-in tool schemas are included only when a previous read
 * left them cached; otherwise that part is labelled as measured at first run.
 */

import type { UIMessage } from 'ai'
import type { ToolSchema } from '@janhq/tauri-plugin-agent-tools-api'
import {
  buildCoworkSystemPrompt,
  type CoworkPromptOptions,
} from '@/lib/coworkPrompt'
import { coworkToolsFromSchemas } from '@/lib/coworkTools'
import {
  ENABLE_TOOLS_NAME,
  enableToolsTool,
  splitToolGroups,
  type ToolGroupId,
} from '@/lib/coworkToolGroups'
import { estimatePreRunContext } from '@/lib/coworkContext'
import type { ContextAccounting } from '@/lib/coworkReadiness'

export type CoworkPreRunInput = {
  prompt: CoworkPromptOptions
  tools: {
    planMode: boolean
    webSearch: boolean
    allowSubagents: boolean
    subagentNames: string[]
    /** Groups a run would start with; omitted measures the full set. */
    offerGroups?: readonly ToolGroupId[]
  }
  /** The backend's schemas when already read, else null (never fetched here). */
  backendSchemas: readonly ToolSchema[] | null
  messages: readonly UIMessage[] | null
  configuredContextTokens?: number | null
}

export function coworkPreRunContext(
  input: CoworkPreRunInput
): ContextAccounting {
  const built = coworkToolsFromSchemas(input.backendSchemas ?? [], input.tools)
  const split = splitToolGroups(
    built,
    input.tools.offerGroups ? new Set(input.tools.offerGroups) : undefined
  )
  return estimatePreRunContext({
    systemPrompt: buildCoworkSystemPrompt(input.prompt),
    toolSchemas:
      split.heldGroups.length > 0
        ? { ...split.lean, [ENABLE_TOOLS_NAME]: enableToolsTool(split.heldGroups) }
        : split.lean,
    backendToolsKnown: input.backendSchemas != null,
    messages: input.messages,
    configuredContextTokens: input.configuredContextTokens,
  })
}
