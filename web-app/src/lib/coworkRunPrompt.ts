import type { UIMessage } from 'ai'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { mcpServerLabels, snapshotMcpTools } from '@/lib/mcpLiveTools'
import { sandboxEnforces } from '@/lib/agentTools'
import { jevModeSuggestion, type JevSuggestedMode } from '@/lib/jevRouting'
import { buildCoworkSystemPrompt, environmentOptions } from '@/lib/coworkPrompt'
import { skillCatalogBlock } from '@/lib/skillCatalog'
import { skillActivationBlock, type ActivatedSkill } from '@/lib/skillActivation'
import { lastUserText } from '@/lib/coworkTransportMessages'
import type { CoworkRunConfig } from '@/lib/coworkRunConfig'
import { assistantProfileBlock } from '@/lib/coworkTransportTools'

/** What a Cowork run's prompt is built from, as the transport holds it now. */
export type CoworkRunPromptInput = {
  messages: UIMessage[]
  threadId: string | undefined
  config: CoworkRunConfig
  /** The names of the tools advertised on this request. */
  availableTools: string[]
  mcp: {
    /** Whether the MCP tools have been read for this run yet. */
    read: boolean
    servers: Map<string, string>
    starting: string[]
    withheldLabels: string[]
  }
  activeSkills: ActivatedSkill[]
  routedAssistantInstructions: string | undefined
  routedMode: JevSuggestedMode | null
}

/**
 * Cowork's own system prompt for a run: policy, folders, tools, project
 * instructions, skills, the work profile and the routed assistant's persona.
 * The transport adds the MCP notes, remembered facts and attached files after
 * it.
 */
export function coworkRunPrompt(input: CoworkRunPromptInput): string {
  const { messages, threadId, config, mcp } = input
  const assistantProfile = assistantProfileBlock(input.routedAssistantInstructions)
  const self = threadId
    ? useCoworkSessions.getState().sessions.find((s) => s.id === threadId)
    : undefined
  return buildCoworkSystemPrompt({
    availableTools: input.availableTools,
    messagingSelf: self ? { id: self.id, name: self.title } : undefined,
    workspacePath: config.workspacePath,
    readOnlyFolder: config.readOnlyFolder,
    extraFolders: config.extraFolders,
    writableExtraFolders: config.writableExtraFolders,
    folderAccess: config.folderAccess,
    worktreeBranch: config.worktreeBranch,
    ...environmentOptions(config),
    mcpServers: !mcp.read
      ? undefined
      : config.planMode
      ? ['none offered (review mode withholds MCP tools)']
      : mcpServerLabels(
          snapshotMcpTools(
            [...mcp.servers].map(([name, server]) => ({ name, server }))
          ),
          mcp.starting,
          mcp.withheldLabels
        ),
    gitBranch: config.gitBranch,
    projectInstructions: config.projectInstructions,
    compatInstructions: config.compatInstructions,
    projectTooling: config.projectTooling,
    planMode: config.planMode,
    userRequest: lastUserText(messages),
    openingInspection: config.openingInspection,
    bashAvailable: sandboxEnforces(),
    subagentNames: config.allowSubagents ? config.subagentNames : [],
    webSearch: config.webSearch,
    skillsBlock: skillCatalogBlock(undefined, config.readOnlyFolder),
    skillActivationBlock: skillActivationBlock(input.activeSkills),
    workProfileBlock: useWorkProfiles.getState().blockFor(threadId),
    assistantProfileBlock: assistantProfile,
    modeSuggestionBlock: jevModeSuggestion(input.routedMode),
  })
}
