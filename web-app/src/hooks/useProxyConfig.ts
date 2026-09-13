import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

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
      setProxyPassword: (proxyPassword) => set({ proxyPassword }),
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
    }
  )
)
