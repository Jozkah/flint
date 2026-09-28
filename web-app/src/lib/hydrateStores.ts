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
import { useDefaultEmbeddingModel } from '@/hooks/useDefaultEmbeddingModel'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { useWebPreviewSettings } from '@/hooks/useWebPreviewSettings'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { usePrStatusStore } from '@/stores/pr-status-store'
import { backfillPrClaims } from '@/lib/prClaimBackfill'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkCheckpoints } from '@/hooks/useCoworkCheckpoints'
import { useFileActivity } from '@/hooks/useFileActivity'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useModelOverrides } from '@/hooks/useModelOverrides'
import { useCoworkDisplay } from '@/hooks/useCoworkDisplay'
import { useKeybindings } from '@/hooks/useKeybindings'
import { useReferenceAliases } from '@/lib/referenceAliases'
import { useProjectInitDrafts } from '@/lib/projectInit'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { useModelDoctor } from '@/hooks/useModelDoctor'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useWorkProfiles } from '@/hooks/useWorkProfiles'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'
import { scheduleRoomRecovery } from '@/lib/rooms/recovery'
// Side effect only in builds with VITE_JAN_E2E_HOOKS=1 (the rooms smoke lane).
import '@/lib/rooms/e2eHooks'
import { useSplitConversation } from '@/hooks/useSplitConversation'
import { useGlobalExtensions } from '@/hooks/useGlobalExtensions'
import { initConversationGroups } from '@/lib/groups/bootstrap'

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
  useDefaultEmbeddingModel,
  useAgentMode,
  useWebSearchConfig,
  useWebPreviewSettings,
  useCoworkSessions,
  useClaudeCompat,
  useCoworkActivity,
  useCoworkCheckpoints,
  useFileActivity,
  useAgentToolsConfig,
  useModelOverrides,
  useCoworkDisplay,
  useKeybindings,
  useReferenceAliases,
  useProjectInitDrafts,
  useModelEvidence,
  useModelDoctor,
  useJevSettings,
  useWorkProfiles,
  useOnboardingGuide,
  useSessionMessaging,
  useSplitConversation,
  useGlobalExtensions,
] as const

export async function hydrateBackendStores(): Promise<void> {
  await Promise.resolve(useTheme.persist.rehydrate())
  await Promise.all(
    secondaryStores.map((store) => Promise.resolve(store.persist.rehydrate()))
  )
  // Secrets are never in the persisted blobs; seed them from the keyring
  // before anything (the server auto-start) reads them.
  await Promise.all([seedLocalApiServerKey(), seedProxyPassword()])
  // Nothing survives a restart: a subagent's stream and a shell's process both
  // died with the process that owned them. Settle whatever the previous app
  // run left in flight, or the panel would show work still running that
  // nothing can ever finish.
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
    void backfillPrClaims(
      useCoworkSessions.getState().sessions.map((s) => ({
        id: s.id,
        folder: s.folder,
        worktreePath: worktrees[s.id]?.path ?? null,
      }))
    )
  }
}

/** Recorded as the reason on work the previous app run left unfinished. */
export const INTERRUPTED_BY_RESTART = 'interrupted:restart'
