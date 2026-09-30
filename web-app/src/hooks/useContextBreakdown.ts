import { create } from 'zustand'
import type { ContextBreakdown } from '@/lib/contextBreakdown'

/**
 * The context breakdown of the last request each conversation sent, by thread
 * or session id. Written by the transport when it builds a request, read by the
 * composer's context circle. Memory only: it describes a request, and the next
 * one replaces it.
 */
type ContextBreakdownState = {
  byId: Record<string, ContextBreakdown>
  set: (id: string, breakdown: ContextBreakdown) => void
  clear: (id: string) => void
}

export const useContextBreakdown = create<ContextBreakdownState>()((set) => ({
  byId: {},
  set: (id, breakdown) => set((s) => ({ byId: { ...s.byId, [id]: breakdown } })),
  clear: (id) =>
    set((s) => {
      const byId = { ...s.byId }
      delete byId[id]
      return { byId }
    }),
}))
