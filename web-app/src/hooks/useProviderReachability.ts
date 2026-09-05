import { create } from 'zustand'

/**
 * Which endpoints have just failed to answer.
 *
 * Derived from requests the app already makes — a real call that failed with a
 * transport error — because probing endpoints to find out would be exactly the
 * background network traffic this build does not do.
 *
 * Deliberately **not** persisted. A provider that was unreachable when the app
 * closed is not necessarily unreachable when it opens, and a stale "Offline"
 * badge is worse than no badge: it accuses a provider that may be fine.
 *
 * Keyed by origin rather than provider id because that is what the failing
 * request knows, and because reachability is a property of the endpoint: two
 * providers pointed at the same gateway share its fate.
 */

export type Unreachable = {
  /** The classified transport failure, for the tooltip. */
  reason: string
  /** When it failed, so the UI can say how stale this is. */
  at: number
}

type ReachabilityState = {
  unreachable: Record<string, Unreachable>
  /** A real request to this origin failed at the transport layer. */
  markUnreachable: (origin: string, reason: string, at?: number) => void
  /** A request to this origin succeeded; whatever was wrong is over. */
  markReachable: (origin: string) => void
  /** The provider's configuration changed, so past failures say nothing. */
  forgetOrigin: (origin: string) => void
  isUnreachable: (origin: string | null | undefined) => boolean
}

/** Loopback is the local engine, whose health is reported by the engine itself. */
export function isLoopback(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(origin)
}

/** The scheme-and-host part of a URL, or null when it is not one. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export const useProviderReachability = create<ReachabilityState>()(
  (set, get) => ({
    unreachable: {},

    markUnreachable: (origin, reason, at) => {
      // A local engine reports its own state; a failed loopback call means the
      // engine is down, which is not the same as a provider being offline.
      if (!origin || isLoopback(origin)) return
      set((s) => ({
        unreachable: { ...s.unreachable, [origin]: { reason, at: at ?? Date.now() } },
      }))
    },

    markReachable: (origin) => {
      if (!origin) return
      set((s) => {
        if (!(origin in s.unreachable)) return s
        const next = { ...s.unreachable }
        delete next[origin]
        return { unreachable: next }
      })
    },

    forgetOrigin: (origin) => get().markReachable(origin),

    isUnreachable: (origin) => Boolean(origin && origin in get().unreachable),
  })
)
