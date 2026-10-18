import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  addonsAvailableHere,
  engineAddon,
  hasUsableAddon,
  parseAddonFailure,
  type AddonFailure,
  type AddonProgress,
  type AddonStatus,
  type RemotePack,
} from '@/services/engineAddon'

/**
 * Where the CUDA add-on offer stands. `idle` covers both "nothing to offer"
 * and "offer available": the card decides from `status` whether to show.
 */
export type AddonPhase = 'idle' | 'downloading' | 'installed' | 'failed'

type Prefs = {
  /** "Don't remind me": the offer card never shows again (Settings still does). */
  neverRemind: boolean
  /** The release the card was last dismissed for ("Not now" = once per version). */
  dismissedFor: string | null
  /** The release the driver notice was last shown for. */
  driverNoticeFor: string | null
}

type State = Prefs & {
  status: AddonStatus | null
  remote: RemotePack | null
  phase: AddonPhase
  progress: AddonProgress | null
  error: AddonFailure | null
  /** A local model finished loading this session: the moment the offer may appear. */
  modelLoadedOnce: boolean
  /** Installed in this session; the card says so until dismissed. */
  justInstalled: boolean
  refresh: () => Promise<AddonStatus | null>
  checkRemote: () => Promise<RemotePack | null>
  download: () => Promise<boolean>
  cancel: () => Promise<void>
  installFile: (path: string) => Promise<boolean>
  remove: () => Promise<boolean>
  verify: () => Promise<boolean | null>
  dismiss: (forever: boolean) => void
  setNeverRemind: (value: boolean) => void
  dismissDriverNotice: () => void
  noteModelLoaded: () => void
}

let unlisten: (() => void) | null = null

export const useEngineAddon = create<State>()(
  persist(
    (set, get) => ({
      neverRemind: false,
      dismissedFor: null,
      driverNoticeFor: null,
      status: null,
      remote: null,
      phase: 'idle',
      progress: null,
      error: null,
      modelLoadedOnce: false,
      justInstalled: false,

      refresh: async () => {
        if (!addonsAvailableHere()) return null
        try {
          const status = await engineAddon.status()
          set((s) => ({
            status,
            phase:
              s.phase === 'downloading'
                ? s.phase
                : hasUsableAddon(status)
                  ? 'installed'
                  : s.phase === 'failed'
                    ? 'failed'
                    : 'idle',
          }))
          return status
        } catch (e) {
          console.warn('engine add-on status unavailable:', e)
          return null
        }
      },

      checkRemote: async () => {
        if (!addonsAvailableHere()) return null
        try {
          const remote = await engineAddon.check()
          set({ remote })
          return remote
        } catch (e) {
          const failure = parseAddonFailure(e)
          set({ remote: null })
          // Not published yet / offline are expected states, not errors to shout.
          if (failure.code !== 'not_published' && failure.code !== 'offline') {
            console.warn('engine add-on manifest check failed:', failure.message)
          }
          return null
        }
      },

      download: async () => {
        if (!addonsAvailableHere() || get().phase === 'downloading') return false
        set({ phase: 'downloading', error: null, progress: null })
        unlisten?.()
        try {
          unlisten = await engineAddon.onProgress((progress) => set({ progress }))
          await engineAddon.download()
          set({ phase: 'installed', progress: null, justInstalled: true })
          await get().refresh()
          return true
        } catch (e) {
          const error = parseAddonFailure(e)
          set({
            phase: error.code === 'cancelled' ? 'idle' : 'failed',
            error: error.code === 'cancelled' ? null : error,
          })
          return false
        } finally {
          unlisten?.()
          unlisten = null
        }
      },

      cancel: async () => {
        await engineAddon.cancel().catch(() => undefined)
      },

      installFile: async (path) => {
        set({ phase: 'downloading', error: null, progress: { phase: 'install', received: 0, total: 0 } })
        try {
          await engineAddon.installFile(path)
          set({ phase: 'installed', progress: null, justInstalled: true })
          await get().refresh()
          return true
        } catch (e) {
          set({ phase: 'failed', error: parseAddonFailure(e), progress: null })
          return false
        }
      },

      remove: async () => {
        try {
          await engineAddon.remove()
          set({ phase: 'idle', error: null, justInstalled: false })
          await get().refresh()
          return true
        } catch (e) {
          set({ error: parseAddonFailure(e) })
          return false
        }
      },

      verify: async () => {
        try {
          const ok = await engineAddon.verify()
          await get().refresh()
          if (!ok) set({ phase: 'idle' })
          return ok
        } catch (e) {
          set({ error: parseAddonFailure(e) })
          return null
        }
      },

      dismiss: (forever) =>
        set((s) => ({
          neverRemind: forever || s.neverRemind,
          dismissedFor: s.status?.release_tag ?? s.dismissedFor,
          phase: s.phase === 'failed' ? 'idle' : s.phase,
          error: null,
          justInstalled: false,
        })),

      setNeverRemind: (value) => set({ neverRemind: value }),

      dismissDriverNotice: () =>
        set((s) => ({ driverNoticeFor: s.status?.release_tag ?? s.driverNoticeFor })),

      noteModelLoaded: () => {
        if (!get().modelLoadedOnce) set({ modelLoadedOnce: true })
      },
    }),
    {
      name: localStorageKey.engineAddon,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (s) => ({
        neverRemind: s.neverRemind,
        dismissedFor: s.dismissedFor,
        driverNoticeFor: s.driverNoticeFor,
      }),
    }
  )
)

/** What the floating card should show, if anything. */
export type OfferView = 'offer' | 'progress' | 'installed' | 'failed' | 'driver' | null

export function offerView(s: Pick<
  State,
  | 'status'
  | 'phase'
  | 'neverRemind'
  | 'dismissedFor'
  | 'driverNoticeFor'
  | 'modelLoadedOnce'
  | 'justInstalled'
>): OfferView {
  const status = s.status
  if (!status || !status.supported) return null
  // Started from the card or Settings: the card follows it to the end.
  if (s.phase === 'downloading') return 'progress'
  if (s.phase === 'failed') return 'failed'
  if (s.justInstalled && hasUsableAddon(status)) return 'installed'
  if (!s.modelLoadedOnce) return null
  if (status.eligibility === 'driver_too_old') {
    return s.driverNoticeFor === status.release_tag ? null : 'driver'
  }
  if (status.eligibility !== 'eligible' || hasUsableAddon(status)) return null
  if (s.neverRemind || s.dismissedFor === status.release_tag) return null
  return 'offer'
}
