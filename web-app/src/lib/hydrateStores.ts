import { useTheme } from '@/hooks/useTheme'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useHardware } from '@/hooks/useHardware'
import {
  useLocalApiServer,
  seedLocalApiServerKey,
} from '@/hooks/useLocalApiServer'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useProxyConfig, seedProxyPassword } from '@/hooks/useProxyConfig'
import { useVulkan } from '@/hooks/useVulkan'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useModelOrder } from '@/hooks/useModelOrder'
import { useModelFilter } from '@/hooks/useModelFilter'
import { useModelLibrary } from '@/hooks/useModelLibrary'
import { useDefaultEmbeddingModel } from '@/hooks/useDefaultEmbeddingModel'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useEngineAddon } from '@/hooks/useEngineAddon'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { useWebPreviewSettings } from '@/hooks/useWebPreviewSettings'
import { useTitleSettings } from '@/hooks/useTitleSettings'
import { useChatRules } from '@/hooks/useChatRules'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { usePrStatusStore } from '@/stores/pr-status-store'
import { backfillPrClaims, pruneOrphanPrRecords } from '@/lib/prClaimBackfill'
import { archiveApi } from '@/lib/archive'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkCheckpoints } from '@/hooks/useCoworkCheckpoints'
import { useFileActivity } from '@/hooks/useFileActivity'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useChatShell } from '@/hooks/useChatShell'
import { useVisualizeConfig } from '@/hooks/useVisualizeConfig'
import { useLeanToolsConfig } from '@/hooks/useLeanToolsConfig'
import { useChatMentionConfig } from '@/hooks/useChatMentionConfig'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useWebSearchChoice } from '@/hooks/useWebSearchChoice'
import { useContextBreakdown } from '@/hooks/useContextBreakdown'
import { useCoworkDisplay } from '@/hooks/useCoworkDisplay'
import { useKeybindings } from '@/hooks/useKeybindings'
import { useReferenceAliases } from '@/lib/referenceAliases'
import { usePromptLibrary } from '@/lib/promptLibrary'
import { useProjectInitDrafts } from '@/lib/projectInit'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { useModelDoctor } from '@/hooks/useModelDoctor'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useAutomationSettings } from '@/hooks/useAutomationSettings'
import { useModelRouting } from '@/hooks/useModelRouting'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { useSubagentSettings } from '@/hooks/useSubagentSettings'
import { useSkillActivation } from '@/hooks/useSkillActivation'
import { useImageDescription } from '@/hooks/useImageDescription'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'
import { useCampaignSettings } from '@/hooks/useCampaignSettings'
import { scheduleRoomRecovery } from '@/lib/rooms/recovery'
// Side effect only in builds with VITE_JAN_E2E_HOOKS=1 (the rooms smoke lane).
import '@/lib/rooms/e2eHooks'
import { useSplitConversation } from '@/hooks/useSplitConversation'
import { useGlobalExtensions } from '@/hooks/useGlobalExtensions'
import { initConversationGroups } from '@/lib/groups/bootstrap'
import { isChatWindow } from '@/lib/soloFlag'
import { hasUsableProvider, isSetupCompleted } from '@/lib/providerReadiness'
import { backendReadFailures } from '@/lib/backendStorage'

/**
 * Stores persisted through `backendStorage` set `skipHydration: true` so they
 * never hit the backend before the ServiceHub is initialized. This runs their
 * rehydration explicitly, once, after init. Called from `ServiceHubProvider`
 * before it renders children, so no component ever sees pre-hydration defaults.
 *
 * Add each migrated store here as it is switched to `backendStorage`.
 */
// useInterfaceSettings' onRehydrateStorage reads useTheme.getState().isDark, so
// theme must hydrate first.
const secondaryStores = [
  usePrStatusStore,
  useInterfaceSettings,
  useGeneralSetting,
  useLeftPanel,
  useModelProvider,
  useHardware,
  useLocalApiServer,
  useToolApproval,
  useToolAvailable,
  useProxyConfig,
  useVulkan,
  useFavoriteModel,
  useModelOrder,
  useModelFilter,
  useModelLibrary,
  useDefaultEmbeddingModel,
  useAgentMode,
  useEngineAddon,
  useWebSearchConfig,
  useWebPreviewSettings,
  useTitleSettings,
  useChatRules,
  useCoworkSessions,
  useClaudeCompat,
  useCoworkActivity,
  useCoworkCheckpoints,
  useFileActivity,
  useAgentToolsConfig,
  useChatShell,
  useVisualizeConfig,
  useLeanToolsConfig,
  useChatMentionConfig,
  useModelOverrides,
  useWebSearchChoice,
  useContextBreakdown,
  useCoworkDisplay,
  useKeybindings,
  useReferenceAliases,
  usePromptLibrary,
  useProjectInitDrafts,
  useModelEvidence,
  useModelDoctor,
  useJevSettings,
  useAutomationSettings,
  useModelRouting,
  useWorkProfiles,
  useSubagentSettings,
  useSkillActivation,
  useImageDescription,
  useOnboardingGuide,
  useSessionMessaging,
  useCampaignSettings,
  useSplitConversation,
  useGlobalExtensions,
] as const

export async function hydrateBackendStores(): Promise<void> {
  await Promise.resolve(useTheme.persist.rehydrate())
  await Promise.all(
    secondaryStores.map((store) => Promise.resolve(store.persist.rehydrate()))
  )
  // A store whose saved settings could not be read stays on defaults and
  // refuses to write them (see backendStorage); the app must not start on it.
  const unread = backendReadFailures()
  if (unread.length > 0) {
    throw new Error(`Could not read saved settings: ${unread.join(', ')}`)
  }
  // Decided here, before the first render, so the sidebar never flashes the
  // full list on a new install.
  useInterfaceSettings.getState().resolveNavDefaults(isExistingInstall())
  // Secrets are never in the persisted blobs; seed them from the keyring
  // before anything (the server auto-start) reads them.
  await Promise.all([seedLocalApiServerKey(), seedProxyPassword()])
  // Nothing survives a restart: a subagent's stream and a shell's process both
  // died with the process that owned them. Settle whatever the previous app
  // run left in flight, or the panel would show work still running that
  // nothing can ever finish.
  // A "New window" is not a restart: the main window's work is still running,
  // and its one-time recoveries are the main window's to do.
  if (isChatWindow()) return
  useCoworkActivity.getState().recoverOnLoad(INTERRUPTED_BY_RESTART)
  // Conversation groups: own per-surface keys, synced across windows. A
  // failure leaves every item visible under Recents.
  await initConversationGroups()
  // Discussion rooms live in backend files, desktop only. Rooms the previous
  // run left running are saved paused; failures are logged, never thrown.
  void scheduleRoomRecovery(IS_TAURI)
  // Pull requests opened before sessions claimed them: claimed once from the
  // event log, so a session sharing a checkout stops showing another's PR.
  if (IS_TAURI) {
    const worktrees = useCoworkWorktrees.getState().bySession
    const sessions = useCoworkSessions.getState().sessions
    // Records of sessions deleted by older builds go first.
    void pruneOrphanPrRecords(
      sessions.map((s) => s.id),
      async () => (await archiveApi.list()).filter((i) => i.kind === 'cowork').map((i) => i.id)
    ).then(() =>
      backfillPrClaims(
        sessions.map((s) => ({
          id: s.id,
          folder: s.folder,
          worktreePath: worktrees[s.id]?.path ?? null,
        }))
      )
    )
  }
}

/**
 * Whether this install was used before: setup finished, a model usable, or a
 * Cowork session saved. Chats load later (from the extension), but anyone with
 * one has also passed setup.
 */
export function isExistingInstall(): boolean {
  return (
    isSetupCompleted() ||
    hasUsableProvider(useModelProvider.getState().providers) ||
    useCoworkSessions.getState().sessions.length > 0
  )
}

/** Recorded as the reason on work the previous app run left unfinished. */
export const INTERRUPTED_BY_RESTART = 'interrupted:restart'
