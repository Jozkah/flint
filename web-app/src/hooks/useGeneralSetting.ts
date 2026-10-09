import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { getServiceHub } from '@/hooks/useServiceHub'

// Namespaced (#138): the bare 'huggingface' entry is also where the built-in
// huggingface provider keeps its API keys, so the two overwrote and deleted
// each other.
export const HUGGINGFACE_TOKEN_SECRET_KEY = 'general:huggingface-token'
/** Where builds before #138 kept the token. */
export const LEGACY_HUGGINGFACE_TOKEN_SECRET_KEY = 'huggingface'
/**
 * Set once the legacy token has been looked at, so the copy runs a single
 * time: repeating it every launch brought back a token the user had cleared.
 */
export const HUGGINGFACE_TOKEN_MIGRATED_SECRET_KEY =
  'general:huggingface-token-migrated'

type SecretInvoke = (
  command: 'get_secret' | 'set_secret',
  args: Record<string, unknown>
) => Promise<unknown>

/**
 * The General Hugging Face token from the keyring. A token saved by an older
 * build sits under the provider's entry; it is copied to the namespaced one
 * once, behind a marker, and the provider's entry is left alone, since it may
 * be the provider's key. A legacy value equal to `providerApiKey` (the
 * huggingface provider's own key, when known) is not copied.
 */
export async function loadHuggingfaceToken(
  invoke: SecretInvoke,
  providerApiKey?: string
): Promise<string | null> {
  const token = await invoke('get_secret', { key: HUGGINGFACE_TOKEN_SECRET_KEY })
  if (typeof token === 'string' && token) return token
  const migrated = await invoke('get_secret', {
    key: HUGGINGFACE_TOKEN_MIGRATED_SECRET_KEY,
  })
  if (typeof migrated === 'string' && migrated) return null
  const legacy = await invoke('get_secret', {
    key: LEGACY_HUGGINGFACE_TOKEN_SECRET_KEY,
  })
  const copy =
    typeof legacy === 'string' && legacy !== '' && legacy !== providerApiKey
  if (copy) {
    await invoke('set_secret', {
      key: HUGGINGFACE_TOKEN_SECRET_KEY,
      value: legacy,
    })
  }
  await invoke('set_secret', {
    key: HUGGINGFACE_TOKEN_MIGRATED_SECRET_KEY,
    value: '1',
  })
  return copy ? legacy : null
}
type GeneralSettingState = {
  currentLanguage: Language
  /** Language replies are pinned to, as the model is told it; '' follows the conversation. */
  replyLanguage: string
  /** `provider::modelId` entries tried in order when the chosen model fails to answer. */
  fallbackModels: string[]
  spellCheckChatInput: boolean
  tokenCounterCompact: boolean
  stripReasoningFromContext: boolean
  /** Hide to the tray instead of quitting when the window is closed. */
  closeToTray: boolean
  setCloseToTray: (value: boolean) => void
  /** Cap on model download speed in MB/s; 0 is unlimited. */
  downloadLimitMBps: number
  setDownloadLimitMBps: (value: number) => void
  huggingfaceToken?: string
  setHuggingfaceToken: (token: string) => void
  setSpellCheckChatInput: (value: boolean) => void
  setTokenCounterCompact: (value: boolean) => void
  setStripReasoningFromContext: (value: boolean) => void
  setCurrentLanguage: (value: Language) => void
  setReplyLanguage: (value: string) => void
  setFallbackModels: (value: string[]) => void
}

export const useGeneralSetting = create<GeneralSettingState>()(
  persist(
    (set) => ({
      currentLanguage: 'en',
      replyLanguage: '',
      fallbackModels: [],
      spellCheckChatInput: true,
      tokenCounterCompact: true,
      stripReasoningFromContext: false,
      closeToTray: false,
      setCloseToTray: (value) => set({ closeToTray: value }),
      downloadLimitMBps: 0,
      setDownloadLimitMBps: (value) =>
        set({
          downloadLimitMBps: Number.isFinite(value) && value > 0 ? value : 0,
        }),
      huggingfaceToken: undefined,
      setSpellCheckChatInput: (value) => set({ spellCheckChatInput: value }),
      setTokenCounterCompact: (value) => set({ tokenCounterCompact: value }),
      setStripReasoningFromContext: (value) =>
        set({ stripReasoningFromContext: value }),
      setCurrentLanguage: (value) => set({ currentLanguage: value }),
      setReplyLanguage: (value) => set({ replyLanguage: value }),
      setFallbackModels: (value) => set({ fallbackModels: value }),
      setHuggingfaceToken: (token) => {
        set({ huggingfaceToken: token })
        // Canonical secret store is the OS keyring, not settings storage.
        getServiceHub()
          .core()
          .invoke('set_secret', {
            key: HUGGINGFACE_TOKEN_SECRET_KEY,
            value: token,
          })
          .catch((err) =>
            console.warn('Failed to persist huggingface token to keyring:', err)
          )
        if (!token) {
          // A cleared token stays cleared: never re-copy the legacy entry.
          getServiceHub()
            .core()
            .invoke('set_secret', {
              key: HUGGINGFACE_TOKEN_MIGRATED_SECRET_KEY,
              value: '1',
            })
            .catch(() => {})
        }
      },
    }),
    {
      name: localStorageKey.settingGeneral,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      // huggingfaceToken is a secret — kept in the OS keyring, never persisted here.
      partialize: (state) => ({
        currentLanguage: state.currentLanguage,
        replyLanguage: state.replyLanguage,
        fallbackModels: state.fallbackModels,
        spellCheckChatInput: state.spellCheckChatInput,
        tokenCounterCompact: state.tokenCounterCompact,
        stripReasoningFromContext: state.stripReasoningFromContext,
        closeToTray: state.closeToTray,
        downloadLimitMBps: state.downloadLimitMBps,
      }),
    }
  )
)


