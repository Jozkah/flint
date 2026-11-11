import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ImportAgent, PriceInput } from '@/lib/usageImport'

/**
 * Settings for the usage import (reading other agents' session logs). It is
 * off until the person turns it on; nothing is scanned before that. Prices set
 * here apply to the imported models only and stay on this computer.
 */
type UsageImportState = {
  enabled: boolean
  /** Window in days; 0 is everything recorded. */
  days: 7 | 30 | 90 | 0
  /** Empty means every agent. */
  agents: ImportAgent[]
  prices: Record<string, PriceInput>
  setEnabled: (v: boolean) => void
  setDays: (v: UsageImportState['days']) => void
  setAgents: (v: ImportAgent[]) => void
  setPrice: (model: string, price: PriceInput | null) => void
}

export const useUsageImport = create<UsageImportState>()(
  persist(
    (set) => ({
      enabled: false,
      days: 30,
      agents: [],
      prices: {},
      setEnabled: (enabled) => set({ enabled }),
      setDays: (days) => set({ days }),
      setAgents: (agents) => set({ agents }),
      setPrice: (model, price) =>
        set((s) => {
          const prices = { ...s.prices }
          if (price) prices[model] = price
          else delete prices[model]
          return { prices }
        }),
    }),
    {
      name: 'flint-usage-import',
      version: 1,
      storage: createJSONStorage(() => localStorage),
    }
  )
)
