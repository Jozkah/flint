import type { VerifyReport } from '@/lib/browserVerify'
import { useBrowserVerify } from '@/hooks/useBrowserVerify'
import { currentDoctorResult, observedToolsFact, useModelDoctor } from '@/hooks/useModelDoctor'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSessionWorkspacePath } from '@/hooks/useSessionWorkspacePath'
import type { Usage } from '@/types/coworkSession'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { rendererReadinessReports } from '@/lib/coworkRendererReadiness'
import { configuredContextTokens } from '@/lib/coworkContextWindow'
import { useCoworkReadiness } from '@/hooks/useCoworkReadiness'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'
import { useCompatManifest } from '@/hooks/useCompatManifest'
import { useImportedMcp } from '@/hooks/useImportedMcp'
import { effectiveEnabled } from '@/hooks/useSkills'
import {
  resolveSkills,
  type ContextAccounting,
  type InstructionFile,
} from '@/lib/coworkReadiness'
import { CoworkChatTransport } from '@/lib/coworkTransport'
import {
  useCoworkWorktrees,
  type WorktreeRecord,
} from '@/hooks/useCoworkWorktrees'
import { coworkWebSearchScope, useWebSearchOn } from '@/hooks/useWebSearchChoice'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { type SubagentDefinition } from '@/lib/coworkSubagentRegistry'
import { type LoadedTooling } from '@/lib/projectTooling'
import { useMCPServers } from '@/hooks/useMCPServers'
import { sessionDetailsLabel } from '@/lib/windowTitle'
import type { Dispatch } from 'react'
import type { SetStateAction } from 'react'
import type { ServiceHub } from '@/services'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { SkillMeta } from '@/lib/skillStore'
import type { ModelCapabilities } from '@/lib/modelCapabilities'
import type { RefObject } from 'react'
import type { CoworkMode } from '@/lib/coworkMode'
import type { EffectiveAccess } from '@/lib/coworkAccess'

const NO_BROWSER_REPORTS: VerifyReport[] = []

export type CoworkSessionContextArgs = {
  folder: string | null
  setFoundWorktrees: Dispatch<SetStateAction<WorktreeRecord[]>>
  serviceHub: ServiceHub
  session: CoworkSession | null
  availableSkills: SkillMeta[]
  enabledSkills: string[]
  advertisedToolNames: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the store's own type
  selectedModel: any
  selectedProvider: string
  getProviderByName: (providerName: string) => ModelProvider | undefined
  modelCapabilities: ModelCapabilities
  transportRef: RefObject<CoworkChatTransport | null>
  runContext: ContextAccounting | null
  mode: CoworkMode
  extraFolders: string[]
  effective: EffectiveAccess
  worktree: WorktreeRecord | undefined
  gitBranch: string | null
  projectInstructions: string | null
  tooling: { folder: string; loaded: LoadedTooling | null; } | null
  instructionFiles: InstructionFile[]
  advertisedToolCount: number | null
  composerPrompt: string
  viewedId: string | null
}

export function useCoworkSessionContext({
  folder,
  setFoundWorktrees,
  serviceHub,
  session,
  availableSkills,
  enabledSkills,
  advertisedToolNames,
  selectedModel,
  selectedProvider,
  getProviderByName,
  modelCapabilities,
  transportRef,
  runContext,
  mode,
  extraFolders,
  effective,
  worktree,
  gitBranch,
  projectInstructions,
  tooling,
  instructionFiles,
  advertisedToolCount,
  composerPrompt,
  viewedId,
}: CoworkSessionContextArgs) {

  useEffect(() => {
    let cancelled = false
    if (!folder) {
      setFoundWorktrees([])
      return
    }
    void (async () => {
      const dataFolder = await serviceHub
        .app()
        .getJanDataFolder()
        .catch(() => '')
      if (!dataFolder) return
      const found = await useCoworkWorktrees.getState().list(folder, dataFolder)
      // The folder may have changed during the round trip; a list from the
      // previous repository would offer the wrong work to recover.
      if (!cancelled) setFoundWorktrees(found)
    })()
    return () => {
      cancelled = true
    }
  }, [folder, serviceHub, setFoundWorktrees])

  /**
   * This session's origin ledger, if a run has produced one.
   *
   * Keyed by session, so switching sessions shows that session's record and
   * never the last run's. Withdrawing access does not touch it: a grant handed
   * back changes what Flint may do next, not what already happened.
   */
  const runOrigins = useCoworkOrigins((s) =>
    session?.id ? (s.bySession[session.id] ?? null) : null
  )

  /**
   * This folder's Claude configuration, resolved for the binding on screen.
   *
   * Readiness shows it and the run freezes it; nothing scans for itself. Three
   * scans at three moments is three different answers to "what is in force",
   * and the user is shown one of them while another is used.
   */
  const skillRoots = useClaudeCompat((s) => s.skillRoots)
  /**
   * The subagents saved in Flint.
   *
   * Declared before the compatibility scan because the scan needs them: an
   * imported agent that reuses one of these names is a duplicate, and it is
   * reported as one rather than quietly losing.
   */
  const [subagentDefs, setSubagentDefs] = useState<SubagentDefinition[]>([])
  // What `@` can name besides files (AH-204): this folder's skills and the
  // saved agents, offered in the composer's one ranked list.
  const referenceSources = useMemo(
    () => ({
      skills: availableSkills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
      agents: subagentDefs.map((agent) => ({
        name: agent.name,
        description: agent.description,
      })),
    }),
    [availableSkills, subagentDefs]
  )

  const {
    manifest: compat,
    mcpProbes,
    rescan: rescanCompat,
  } = useCompatManifest({
    binding: { sessionId: session?.id ?? null, folder },
    enabledSkills: new Set(
      effectiveEnabled(
        enabledSkills,
        availableSkills.map((s) => s.name)
      )
    ),
    availableTools: advertisedToolNames,
    // So an imported agent reusing a saved name is reported as a duplicate
    // rather than quietly losing to it.
    savedAgentNames: subagentDefs.map((one) => one.name),
    // Only what the user approved through the picker. Never anything a
    // repository named.
    approvedUserSkillRoots: skillRoots,
  })

  const settingsMcpServers = useMCPServers(
    (s) => Object.values(s.mcpServers).filter((c) => c?.active).length
  )
  // The servers a run would be offered right now: switched on and listing tools.
  const mcpToolList = useAppState((s) => s.tools)
  const mcpServerConfigs = useMCPServers((s) => s.mcpServers)
  const connectedMcpServers = useMemo(
    () =>
      [
        ...new Set(
          mcpToolList
            .map((tool) => tool.server)
            .filter((server) => mcpServerConfigs[server]?.active)
        ),
      ].sort(),
    [mcpToolList, mcpServerConfigs]
  )
  const doctorResults = useModelDoctor((s) => s.results)
  const browserReports =
    useBrowserVerify((s) => (session?.id ? s.reports[session.id] : undefined)) ?? NO_BROWSER_REPORTS
  // Model, context, MCP and local runtime are facts only this page holds; the
  // backend leaves them "checking" until they are reported.
  const rendererReports = useMemo(
    () =>
      rendererReadinessReports({
        model: selectedModel?.id
          ? {
              id: selectedModel.id,
              provider: selectedProvider ?? '',
              supportsTools: selectedModel.capabilities
                ? selectedModel.capabilities.includes('tools')
                : null,
              observedTools: observedToolsFact(
                currentDoctorResult(
                  doctorResults,
                  selectedProvider ? getProviderByName(selectedProvider) : undefined,
                  selectedModel ?? undefined
                )
              ),
            }
          : null,
        contextTokens: configuredContextTokens(modelCapabilities),
        settingsMcpServers,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedModel, selectedProvider, modelCapabilities, settingsMcpServers, doctorResults]
  )
  const workspacePath = useSessionWorkspacePath(session?.id)
  // Settings decide the default; the session's own switch, once flipped, wins.
  const webSearchEnabled = useWebSearchOn(
    session?.id ? coworkWebSearchScope(session.id) : null
  )
  const hasTurns = (session?.turns?.length ?? 0) > 0
  // A Settings toggle applies at the next run, like a mode change: the run's
  // advertised set is frozen for its lifetime, so the toggle is pushed to the
  // transport in place (web tools added or removed) rather than letting the
  // next step rebuild the set and discard the prompt prefix.
  useEffect(() => {
    transportRef.current?.setWebSearch(webSearchEnabled)
  }, [webSearchEnabled, transportRef])
  /**
   * What a run started now would send, before one has.
   *
   * Pure construction only: the system prompt with the project instructions
   * the run would carry, and the tool set from schemas already in hand. The
   * backend's tool schemas are never fetched for this -- that probes
   * readiness -- so when none are cached the card says that part is measured
   * at first run. Retrieved memory and the toolchain probe are left out for
   * the same reason; the run's own measurement replaces this once it exists.
   */
  const { readiness } = useCoworkReadiness({
    sessionId: session?.id,
    messages: session?.messages,
    runContext,
    mode,
    subagentDefs,
    workspacePath,
    folder,
    extraFolders,
    destination: effective.destination,
    worktree,
    gitBranch,
    projectInstructions,
    compat,
    tooling,
    webSearchEnabled,
    hasTurns,
    modelCapabilities,
    instructionFiles,
    baseline: runOrigins?.context.baseline,
    advertisedToolCount,
    connectedMcpServers,
    availableSkills,
    enabledSkills,
    composerPrompt,
    selectedModel,
  })

  // Read inside the instruction effect without making the session a dependency:
  // the effect keys on the folder, and the ref is only used to notice that the
  // session changed underneath a read that was already in flight.
  /** The last run's resolved skills, so a retake does not lose them. */
  /**
   * A few words for the session-details trigger: the repository and branch,
   * which is what someone glances at to confirm they are in the right place.
   * The rest lives inside the dialog.
   */
  const sessionDetailsSummary = useMemo(
    () => sessionDetailsLabel(readiness.folder, readiness.branch),
    [readiness.folder, readiness.branch]
  )

  // A retake re-uses the skills of the turn it takes again -- that session's
  // turn, not whichever session ran last.
  const runSkillsRef = useRef<Record<string, ReturnType<typeof resolveSkills>>>(
    {}
  )
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = session?.id ?? null

  /**
   * Flint's own data folder, so an imported MCP server can be kept out of it.
   *
   * Read once: it does not change while the app is running, and an imported
   * server has no business in the app's storage whatever the repository that
   * named it would like.
   */
  const [janDataFolder, setJanDataFolder] = useState<string | null>(null)
  useEffect(() => {
    void serviceHub
      .app()
      .getJanDataFolder()
      .then((path) => setJanDataFolder(path ?? null))
      .catch(() => setJanDataFolder(null))
  }, [serviceHub])

  const { setConsent: setMcpConsent, revalidate: revalidateMcp } =
    useImportedMcp({
      folder,
      workspacePath,
      dataFolder: janDataFolder,
      // A write root only where the session actually holds one: an imported
      // server never gets authority the run itself does not have.
      writableRepository:
        effective.access === 'edit-folder' ? effective.writeRoot : null,
      // The session's extra folders, readable to a confined server as they
      // are to the run's own tools.
      readRoots: extraFolders,
    })

  /**
   * A definition edited after it was allowed is a different program.
   *
   * Checked whenever the scan produces new definitions: the consent is
   * withdrawn and the running server stopped, rather than left up under a
   * permission that was given for something else.
   */
  useEffect(() => {
    void revalidateMcp(mcpProbes)
  }, [mcpProbes, revalidateMcp])

  // The step just finished, so the counter tracks a run instead of jumping once
  // at the end. Falls back to the committed usage between runs.
  const liveUsage: Usage | null = useCoworkRun(
    (s) => (viewedId ? s.usage[viewedId] : undefined) ?? null
  )
  return {
    workspacePath,
    setSubagentDefs,
    sessionIdRef,
    runOrigins,
    liveUsage,
    compat,
    runSkillsRef,
    subagentDefs,
    readiness,
    settingsMcpServers,
    rendererReports,
    mcpProbes,
    setMcpConsent,
    skillRoots,
    janDataFolder,
    rescanCompat,
    sessionDetailsSummary,
    browserReports,
    referenceSources,
  }
}
