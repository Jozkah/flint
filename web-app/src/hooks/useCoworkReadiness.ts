import { effectiveEnabled } from '@/hooks/useSkills'
import { peekAgentToolSchemas, sandboxEnforces } from '@/lib/agentTools'
import { compatInstructionBlocks, mergeSkillRegistry } from '@/lib/claudeCompat'
import { measureContextPack } from '@/lib/coworkContext'
import { isReadOnly } from '@/lib/coworkMode'
import { evidenceLimit } from '@/lib/coworkOrigins'
import { coworkPreRunContext } from '@/lib/coworkPreRun'
import { type ContextAccounting, type ReadinessManifest, parseSkillRequests, resolveSkills } from '@/lib/coworkReadiness'
import { configuredContextTokens } from '@/lib/coworkContextWindow'
import type { SubagentDefinition } from '@/lib/coworkSubagentRegistry'
import { groupsToOffer } from '@/lib/coworkToolGroups'
import { useMemo } from 'react'
import type { WorktreeRecord } from '@/hooks/useCoworkWorktrees'
import type { LoadedTooling } from '@/lib/projectTooling'

type PromptInputs = Parameters<typeof coworkPreRunContext>[0]['prompt']

export type CoworkReadinessInputs = {
  sessionId: string | undefined
  messages: Parameters<typeof groupsToOffer>[0]['history'] | undefined
  runContext: ContextAccounting | null
  mode: Parameters<typeof isReadOnly>[0]
  subagentDefs: SubagentDefinition[]
  workspacePath: PromptInputs['workspacePath']
  folder: string | null
  extraFolders: PromptInputs['extraFolders']
  destination: ReadinessManifest['writeDestination']
  worktree: WorktreeRecord | undefined
  gitBranch: string | null
  projectInstructions: string | null
  compat: Parameters<typeof compatInstructionBlocks>[0]
  tooling: { folder: string; loaded: LoadedTooling | null } | null
  webSearchEnabled: boolean
  hasTurns: boolean
  modelCapabilities: Parameters<typeof configuredContextTokens>[0]
  instructionFiles: ReadinessManifest['instructions']
  baseline: Parameters<typeof evidenceLimit>[0] | undefined
  advertisedToolCount: number | null
  connectedMcpServers: ReadinessManifest['tools']['mcpServers']
  availableSkills: Array<{ name: string }>
  enabledSkills: string[]
  composerPrompt: string
  selectedModel: { id: string; capabilities?: string[] } | null | undefined
}

/**
 * What the readiness card shows: the context a run would carry before it has
 * started, and the full manifest built from it.
 */
export function useCoworkReadiness({
  sessionId,
  messages,
  runContext,
  mode,
  subagentDefs,
  workspacePath,
  folder,
  extraFolders,
  destination,
  worktree,
  gitBranch,
  projectInstructions,
  compat,
  tooling,
  webSearchEnabled,
  hasTurns,
  modelCapabilities,
  instructionFiles,
  baseline,
  advertisedToolCount,
  connectedMcpServers,
  availableSkills,
  enabledSkills,
  composerPrompt,
  selectedModel,
}: CoworkReadinessInputs) {
  const preRunContext = useMemo<ContextAccounting | null>(() => {
    if (runContext) return null
    const planMode = isReadOnly(mode)
    const subagentNames = subagentDefs.map((d) => d.name)
    return coworkPreRunContext({
      prompt: {
        workspacePath,
        readOnlyFolder: folder,
        extraFolders,
        worktreeBranch:
          destination === 'managed'
            ? (worktree?.branch ?? null)
            : null,
        gitBranch,
        projectInstructions,
        compatInstructions: compatInstructionBlocks(compat),
        projectTooling:
          folder && tooling?.folder === folder
            ? (tooling.loaded?.prompt ?? null)
            : null,
        planMode,
        bashAvailable: sandboxEnforces(),
        subagentNames,
        webSearch: webSearchEnabled,
        platform: IS_WINDOWS ? 'windows' : IS_MACOS ? 'macos' : 'linux',
        shellFlavor: IS_WINDOWS ? 'powershell' : 'posix',
        mcpServers: [],
      },
      tools: {
        planMode,
        webSearch: webSearchEnabled,
        allowSubagents: true,
        subagentNames,
        // What a run started with no message yet would carry: the core set.
        offerGroups: groupsToOffer({ text: '', history: messages ?? [] }),
      },
      backendSchemas: peekAgentToolSchemas(folder ?? undefined, 'session'),
      messages: hasTurns ? null : [],
      configuredContextTokens: configuredContextTokens(modelCapabilities),
    })
  }, [
    runContext,
    mode,
    messages,
    subagentDefs,
    workspacePath,
    folder,
    extraFolders,
    destination,
    worktree?.branch,
    gitBranch,
    projectInstructions,
    compat,
    tooling,
    webSearchEnabled,
    hasTurns,
    modelCapabilities,
  ])
  const readiness = useMemo<ReadinessManifest>(() => {
    const registry = mergeSkillRegistry(compat, {
      available: availableSkills.map((skill) => ({ name: skill.name })),
      enabled: new Set(
        effectiveEnabled(
          enabledSkills,
          availableSkills.map((skill) => skill.name)
        )
      ),
    })
    const requested = parseSkillRequests(
      composerPrompt,
      registry.available.map((skill) => skill.name)
    )
    return {
      binding: { sessionId: sessionId ?? null, folder },
      folder,
      branch: gitBranch,
      mode,
      // From the effective access, not the stored preference: a session that
      // remembers "edit this folder" but holds no live grant writes to its
      // sandbox, and the card has to say so.
      writeDestination: destination,
      // Only when that is where writes actually go. A session holding a
      // worktree record but running in Review must not be shown a destination
      // it is not using.
      worktree:
        destination === 'managed' && worktree
          ? {
              path: worktree.path,
              branch: worktree.branch,
              baseSha: worktree.baseSha,
              uncommittedAtCreation: worktree.uncommittedAtCreation,
            }
          : null,
      instructions: instructionFiles,
      // The same merged registry the run resolves against, so the card cannot
      // call a skill available that the run will report missing.
      skills: resolveSkills(requested, registry),
      // Null until a run has built its tool set: before that nothing knows
      // the number, and stating one would be inventing it.
      tools: { builtins: advertisedToolCount, mcpServers: connectedMcpServers },
      model: {
        id: selectedModel?.id ?? null,
        supportsTools: selectedModel
          ? Boolean(selectedModel.capabilities?.includes('tools'))
          : null,
      },
      // From the run's own snapshot when there is one, so the card and the
      // summary cannot disagree about whether anything is attributable.
      evidence: evidenceLimit(baseline ?? null),
      // Only the read for this folder: a late answer for another is ignored.
      tooling: folder
        ? tooling?.folder === folder && tooling.loaded
          ? tooling.loaded.readiness
          : { state: 'loading' }
        : undefined,
      // From the run's own payload once there is one. Before that the
      // categories that depend on it stay unknown rather than zero: a run that
      // has not been built has not sent nothing, it has sent nothing *yet*.
      context:
        runContext ??
        preRunContext ??
        measureContextPack({
          systemPrompt: null,
          toolSchemas: null,
          messages: null,
          configuredContextTokens: configuredContextTokens(modelCapabilities),
        }),
    }
  }, [
    sessionId,
    folder,
    gitBranch,
    mode,
    instructionFiles,
    destination,
    worktree,
    compat,
    baseline,
    tooling,
    advertisedToolCount,
    connectedMcpServers,
    runContext,
    preRunContext,
    availableSkills,
    enabledSkills,
    composerPrompt,
    selectedModel,
    modelCapabilities,
  ])
  return { preRunContext, readiness }
}
