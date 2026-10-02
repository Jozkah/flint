import { useEffect } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { toast } from 'sonner'
import { checkForNewerBuild, releaseUrl, type BuildCheck } from '@/lib/buildUpdate'

/** At most one automatic look per this long, so opening the app often costs nothing. */
export const CHECK_EVERY_MS = 12 * 60 * 60 * 1000

type State = {
  /** Off by default: Flint makes no request nobody asked for. */
  enabled: boolean
  checkedAt: number
  /** The release commit the person was last told about, so a notice is not repeated. */
  notifiedFor: string
  last: BuildCheck | null
  setEnabled: (on: boolean) => void
  run: (opts?: { manual?: boolean }) => Promise<BuildCheck>
}

export const useBuildUpdate = create<State>()(
  persist(
    (set, get) => ({
      enabled: false,
      checkedAt: 0,
      notifiedFor: '',
      last: null,
      setEnabled: (enabled) => set({ enabled }),
      run: async ({ manual = false } = {}) => {
        const result = await checkForNewerBuild(BUILD_COMMIT, VERSION)
        const remembered = get().notifiedFor
        set({ last: result, ...(result.state === 'unknown' ? {} : { checkedAt: Date.now() }) })
        if (result.state === 'newer' && (manual || result.latest !== remembered)) {
          set({ notifiedFor: result.latest })
          toast.warning('A newer Flint build is available', {
            description:
              'This version is a nightly, so the number stays the same. Download it again to update; installed copies do not update themselves.',
            duration: 15000,
            action: {
              label: 'Open release',
              onClick: () => window.open(releaseUrl(VERSION), '_blank', 'noopener'),
            },
          })
        }
        return result
      },
    }),
    {
      name: 'flint-build-update',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ enabled: s.enabled, checkedAt: s.checkedAt, notifiedFor: s.notifiedFor }) as State,
    }
  )
)

/** Looks for a newer build on start when the person turned that on. */
export function useBuildUpdateCheck() {
  const enabled = useBuildUpdate((s) => s.enabled)
  useEffect(() => {
    if (!enabled) return
    if (Date.now() - useBuildUpdate.getState().checkedAt < CHECK_EVERY_MS) return
    void useBuildUpdate.getState().run()
  }, [enabled])
}
