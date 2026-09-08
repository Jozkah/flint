import { useTheme } from '@/hooks/useTheme'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useHardware } from '@/hooks/useHardware'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useProxyConfig } from '@/hooks/useProxyConfig'
import { useVulkan } from '@/hooks/useVulkan'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useModelOrder } from '@/hooks/useModelOrder'
import { useJanModelPromptDismissed } from '@/hooks/useJanModelPrompt'
import { useDefaultEmbeddingModel } from '@/hooks/useDefaultEmbeddingModel'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { useClaudeCompat } from '@/hooks/useClaudeCompat'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkCheckpoints } from '@/hooks/useCoworkCheckpoints'
import { useFileActivity } from '@/hooks/useFileActivity'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'
import { useModelOverrides } from '@/hooks/useModelOverrides'

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
  useInterfaceSettings,
  useGeneralSetting,
  useLeftPanel,
  useModelProvider,
  useHardware,
  useLocalApiServer,
  useToolApproval,
  useToolAvailable,
  useDownloadStore,
  useProxyConfig,
  useVulkan,
  useFavoriteModel,
  useModelOrder,
  useJanModelPromptDismissed,
  useDefaultEmbeddingModel,
  useAgentMode,
  useWebSearchConfig,
  useCoworkSessions,
  useClaudeCompat,
  useCoworkActivity,
  useCoworkCheckpoints,
  useFileActivity,
  useAgentToolsConfig,
  useModelOverrides,
] as const

export async function hydrateBackendStores(): Promise<void> {
  await Promise.resolve(useTheme.persist.rehydrate())
  await Promise.all(
    secondaryStores.map((store) => Promise.resolve(store.persist.rehydrate()))
  )
  // Nothing survives a restart: a subagent's stream and a shell's process both
  // died with the process that owned them. Settle whatever the previous app
  // run left in flight, or the panel would show work still running that
  // nothing can ever finish.
  useCoworkActivity.getState().recoverOnLoad(INTERRUPTED_BY_RESTART)
}

/** Recorded as the reason on work the previous app run left unfinished. */
export const INTERRUPTED_BY_RESTART = 'interrupted:restart'
