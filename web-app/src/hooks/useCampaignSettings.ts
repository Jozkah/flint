import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  CAMPAIGN_DEFAULT_MAX_PARALLEL,
  clampCampaignParallel,
} from '@/lib/campaignModel'

/**
 * Settings for Campaigns (docs/CAMPAIGNS.md).
 *
 * `maxParallel` is how many campaign tasks may run at once. It is read each
 * time the scheduler decides, so changing it applies to a running campaign
 * without a restart. Free split panes still cap the effective value.
 */
type CampaignSettingsState = {
  maxParallel: number
  setMaxParallel: (value: number) => void
}

export const useCampaignSettings = create<CampaignSettingsState>()(
  persist(
    (set) => ({
      maxParallel: CAMPAIGN_DEFAULT_MAX_PARALLEL,
      setMaxParallel: (value) =>
        set({ maxParallel: clampCampaignParallel(value) }),
    }),
    {
      name: localStorageKey.campaignSettings,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (state) => ({ maxParallel: state.maxParallel }),
      // A hand-edited or older blob never lifts the value out of range.
      merge: (persisted, current) => ({
        ...current,
        maxParallel: clampCampaignParallel(
          (persisted as { maxParallel?: unknown } | undefined)?.maxParallel
        ),
      }),
    }
  )
)
