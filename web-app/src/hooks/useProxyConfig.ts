import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  PROXY_PASSWORD_SECRET,
  moveFieldToKeyring,
  persistStoreSecret,
  readStoreSecret,
} from '@/lib/storeSecrets'

type ProxyConfigState = {
  proxyEnabled: boolean
  proxyUrl: string
  proxyUsername: string
  proxyPassword: string
  proxyIgnoreSSL: boolean
  verifyProxySSL: boolean
  verifyProxyHostSSL: boolean
  verifyPeerSSL: boolean
  verifyHostSSL: boolean
  noProxy: string
  /** A PEM bundle of extra certificate authorities to trust (AH-190). */
  caBundlePath: string
  // Function to set the proxy configuration
  setProxyEnabled: (proxyEnabled: boolean) => void
  setProxyUrl: (proxyUrl: string) => void
  setProxyUsername: (proxyUsername: string) => void
  setProxyPassword: (proxyPassword: string) => void
  setProxyIgnoreSSL: (proxyIgnoreSSL: boolean) => void
  setVerifyProxySSL: (verifyProxySSL: boolean) => void
  setVerifyProxyHostSSL: (verifyProxyHostSSL: boolean) => void
  setVerifyPeerSSL: (verifyPeerSSL: boolean) => void
  setVerifyHostSSL: (verifyHostSSL: boolean) => void
  setNoProxy: (noProxy: string) => void
  setCaBundlePath: (caBundlePath: string) => void
}

/**
 * What of the store is written to `settings.json`: everything except the proxy
 * password, which is a secret and lives in the OS keyring.
 */
export function persistedProxyConfigState(
  state: ProxyConfigState
): Partial<ProxyConfigState> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { proxyPassword, ...rest } = state
  return rest
}

export const useProxyConfig = create<ProxyConfigState>()(
  persist(
    (set) => ({
      proxyEnabled: false,
      proxyUrl: '',
      proxyUsername: '',
      proxyPassword: '',
      proxyIgnoreSSL: false,
      verifyProxySSL: true,
      verifyProxyHostSSL: true,
      verifyPeerSSL: true,
      verifyHostSSL: true,
      noProxy: '',
      caBundlePath: '',
      setProxyEnabled: (proxyEnabled) => set({ proxyEnabled }),
      setProxyUrl: (proxyUrl) => set({ proxyUrl }),
      setProxyUsername: (proxyUsername) => set({ proxyUsername }),
      setProxyPassword: (proxyPassword) => {
        set({ proxyPassword })
        // A secret: kept in the OS keyring, never in settings.json.
        void persistStoreSecret(PROXY_PASSWORD_SECRET, proxyPassword)
      },
      setProxyIgnoreSSL: (proxyIgnoreSSL) => set({ proxyIgnoreSSL }),
      setVerifyProxySSL: (verifyProxySSL) => set({ verifyProxySSL }),
      setVerifyProxyHostSSL: (verifyProxyHostSSL) =>
        set({ verifyProxyHostSSL }),
      setVerifyPeerSSL: (verifyPeerSSL) => set({ verifyPeerSSL }),
      setVerifyHostSSL: (verifyHostSSL) => set({ verifyHostSSL }),
      setNoProxy: (noProxy) => set({ noProxy }),
      setCaBundlePath: (caBundlePath) => set({ caBundlePath }),
    }),
    {
      name: localStorageKey.settingProxyConfig,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: persistedProxyConfigState,
      version: 1,
      migrate: async (persistedState: unknown, version: number) => {
        const state = persistedState as Record<string, unknown>
        if (version < 1) {
          // v0 -> v1: the password moves out of settings.json into the keyring.
          await moveFieldToKeyring(state, 'proxyPassword', PROXY_PASSWORD_SECRET)
        }
        return state as unknown as ProxyConfigState
      },
    }
  )
)

/** Re-seed the proxy password from the keyring after the store hydrates. */
export async function seedProxyPassword(): Promise<void> {
  const password = await readStoreSecret(PROXY_PASSWORD_SECRET)
  if (password) useProxyConfig.setState({ proxyPassword: password })
}
