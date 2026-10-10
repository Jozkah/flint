import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  LOCAL_API_SERVER_KEY_SECRET,
  moveFieldToKeyring,
  persistStoreSecret,
  readStoreSecret,
} from '@/lib/storeSecrets'

type LocalApiServerState = {
  // Run local API server once app opens
  enableOnStartup: boolean
  setEnableOnStartup: (value: boolean) => void
  // Keep the app running in the tray when the window closes while the server is on
  runInBackground: boolean
  setRunInBackground: (value: boolean) => void
  // Default local model to auto-load when the server starts
  defaultModelLocalApiServer: { model: string; provider: string } | null
  setDefaultModelLocalApiServer: (
    model: { model: string; provider: string } | null
  ) => void
  // Last models that were running when server started (can be multiple local/remote models)
  lastServerModels: { model: string; provider: string }[]
  setLastServerModels: (models: { model: string; provider: string }[]) => void
  // Server host option (127.0.0.1 or 0.0.0.0)
  serverHost: '127.0.0.1' | '0.0.0.0'
  setServerHost: (value: '127.0.0.1' | '0.0.0.0') => void
  // Server port (default 1337)
  serverPort: number
  setServerPort: (value: number) => void
  // Port the running server actually bound. It differs from serverPort when the
  // backend fell back to a free port; it is never persisted, so the user's
  // configured port is tried again on the next start.
  activeServerPort: number | null
  setActiveServerPort: (value: number | null) => void
  // API prefix (default /v1)
  apiPrefix: string
  setApiPrefix: (value: string) => void
  // CORS enabled
  corsEnabled: boolean
  setCorsEnabled: (value: boolean) => void
  // Verbose server logs
  verboseLogs: boolean
  setVerboseLogs: (value: boolean) => void
  apiKey: string
  setApiKey: (value: string) => void
  // Trusted hosts
  trustedHosts: string[]
  addTrustedHost: (host: string) => void
  removeTrustedHost: (host: string) => void
  setTrustedHosts: (hosts: string[]) => void
  // Server request timeout (default 600 sec)
  proxyTimeout: number
  setProxyTimeout: (value: number) => void
  // Execute tools on the Local API server for chat endpoints
  enableServerToolExecution: boolean
  setEnableServerToolExecution: (value: boolean) => void
}

/**
 * What of the store is written to `settings.json`: everything except the API
 * key, which is a secret and lives in the OS keyring.
 */
export function persistedLocalApiServerState(
  state: LocalApiServerState
): Partial<LocalApiServerState> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKey, activeServerPort, ...rest } = state
  return rest
}

export const useLocalApiServer = create<LocalApiServerState>()(
  persist(
    (set) => ({
      enableOnStartup: false,
      setEnableOnStartup: (value) => set({ enableOnStartup: value }),
      runInBackground: true,
      setRunInBackground: (value) => set({ runInBackground: value }),
      defaultModelLocalApiServer: null,
      setDefaultModelLocalApiServer: (model) =>
        set({ defaultModelLocalApiServer: model }),
      lastServerModels: [],
      setLastServerModels: (models) => set({ lastServerModels: models }),
      serverHost: '127.0.0.1',
      setServerHost: (value) => set({ serverHost: value }),
      // Use port 0 (auto-assign) for mobile to avoid conflicts, 1337 for desktop
      serverPort: (typeof window !== 'undefined' && (window as { IS_ANDROID?: boolean }).IS_ANDROID) || (typeof window !== 'undefined' && (window as { IS_IOS?: boolean }).IS_IOS) ? 0 : 1337,
      setServerPort: (value) => set({ serverPort: value }),
      activeServerPort: null,
      setActiveServerPort: (value) => set({ activeServerPort: value }),
      apiPrefix: '/v1',
      setApiPrefix: (value) => set({ apiPrefix: value }),
      corsEnabled: true,
      setCorsEnabled: (value) => set({ corsEnabled: value }),
      verboseLogs: true,
      setVerboseLogs: (value) => set({ verboseLogs: value }),
      trustedHosts: [],
      addTrustedHost: (host) =>
        set((state) => ({
          trustedHosts: [...state.trustedHosts, host],
        })),
      removeTrustedHost: (host) =>
        set((state) => ({
          trustedHosts: state.trustedHosts.filter((h) => h !== host),
        })),
      setTrustedHosts: (hosts) => set({ trustedHosts: hosts }),
      proxyTimeout: 600,
      setProxyTimeout: (value) => set({ proxyTimeout: value }),
      enableServerToolExecution: false,
      setEnableServerToolExecution: (value) =>
        set({ enableServerToolExecution: value }),
      apiKey: '',
      setApiKey: (value) => {
        set({ apiKey: value })
        // The key is a secret: kept in the OS keyring, never in settings.json.
        void persistStoreSecret(LOCAL_API_SERVER_KEY_SECRET, value)
      },
    }),
    {
      name: localStorageKey.settingLocalApiServer,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: persistedLocalApiServerState,
      version: 5,
      migrate: async (persistedState: unknown, version: number) => {
        const state = persistedState as Partial<LocalApiServerState>
        if (version < 1) {
          // v0 → v1: add lastServerModels field
          state.lastServerModels = []
        }
        if (version < 2) {
          // v1 → v2: add defaultModelLocalApiServer field
          state.defaultModelLocalApiServer = null
        }
        if (version < 3) {
          // v2 -> v3: add server-side tool execution toggle
          state.enableServerToolExecution = false
        }
        if (version < 4) {
          // v3 -> v4: add run-in-background toggle (matches previous behavior)
          state.runInBackground = true
        }
        if (version < 5) {
          // v4 -> v5: the API key moves out of settings.json into the keyring.
          await moveFieldToKeyring(
            state as Record<string, unknown>,
            'apiKey',
            LOCAL_API_SERVER_KEY_SECRET
          )
        }
        return state as LocalApiServerState
      },
    }
  )
)

/** Re-seed the API key from the keyring after the store hydrates. */
export async function seedLocalApiServerKey(): Promise<void> {
  const key = await readStoreSecret(LOCAL_API_SERVER_KEY_SECRET)
  if (key) useLocalApiServer.setState({ apiKey: key })
}
