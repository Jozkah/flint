import { useEffect } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { isPlatformTauri } from '@/lib/platform/utils'
import { backendStorage } from '@/lib/backendStorage'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'

/**
 * Pull-request status per project folder, read through the GitHub CLI by the
 * `agent_pr_status` command. Nothing is stored between launches and no token
 * is kept: when `gh` is missing or signed out the lookup says so and the UI
 * shows no pull-request marks.
 *
 * The lookup answers for a folder's current branch, which every session
 * attached to that folder shares when they work in the folder's own checkout
 * (sessions from before per-session worktrees, or with worktrees turned off).
 * So a pull request is also claimed by the session whose push or `gh pr`
 * call produced it, and a session that did not claim it is not shown it:
 * session 3a6cdcf3 showed PR #31 as its own although session 8411d403 opened
 * it on the shared KewScraper checkout. Claims (and whether the one-time
 * backfill from the event log ran) are the only things kept between
 * launches, in the backend settings store beside the sessions.
 */

export type PrState = 'open' | 'draft' | 'merged' | 'closed'

export type PrStatus = {
  number: number
  title: string
  url: string
  state: PrState
  head: string
  base: string
  additions: number
  deletions: number
  checks: { passed: number; failed: number; pending: number }
}

export type PrLookup =
  | { kind: 'found'; pr: PrStatus }
  | { kind: 'no_pull_request' }
  | { kind: 'gh_missing' }
  | { kind: 'gh_signed_out' }
  | { kind: 'not_a_repository' }
  | { kind: 'failed'; message: string }

/** Re-ask at most this often per folder; merges and checks change slowly. */
const FRESH_MS = 2 * 60_000

type Entry = { lookup: PrLookup | null; at: number; loading: boolean }

type PrStatusState = {
  byFolder: Record<string, Entry>
  /** `folder#number` to the id of the session that opened or pushed it. */
  claims: Record<string, string>
  /** The event-log backfill of claims (`backfillPrClaims`) has run. */
  backfilled: boolean
  /** Record claims, keeping any a session already holds. */
  addClaims: (claims: Record<string, string>) => void
  markBackfilled: () => void
  /**
   * Ask for `folder`'s pull request. `claimant` is the session whose git call
   * prompted the ask; a pull request found for it, and not already claimed,
   * becomes that session's.
   */
  refresh: (folder: string, force?: boolean, claimant?: string) => Promise<void>
}

export function claimKey(folder: string, number: number): string {
  return `${folder}#${number}`
}

/**
 * Whether `sessionId` is shown `pr` for `folder`: yes unless another session
 * claimed it. An unclaimed pull request (opened outside Flint, or before
 * claims existed) stays visible to every session on the folder.
 */
export function prVisibleTo(
  pr: PrStatus,
  folder: string,
  claims: Record<string, string>,
  sessionId: string | null | undefined
): boolean {
  const owner = claims[claimKey(folder, pr.number)]
  return !owner || owner === sessionId
}

/**
 * How `sessionId` relates to `pr`:
 * - `mine`: it claimed the pull request, or nobody did and the session's own
 *   branch or worktree is the pull request's head;
 * - `foreign`: nobody claimed it (opened outside Flint) and the session only
 *   shares the checkout, so it is shown muted as "not opened here";
 * - `hidden`: another session claimed it.
 * Without a session (nothing to tell apart) an unclaimed one is `mine`.
 */
export type PrRelation = 'mine' | 'foreign' | 'hidden'

export function prRelation(
  pr: PrStatus,
  folder: string,
  claims: Record<string, string>,
  sessionId: string | null | undefined,
  ownWorktree?: { path?: string; branch?: string } | null
): PrRelation {
  if (!prVisibleTo(pr, folder, claims, sessionId)) return 'hidden'
  if (claims[claimKey(folder, pr.number)] || !sessionId) return 'mine'
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  const ownsHead =
    !!ownWorktree &&
    ((!!ownWorktree.path && norm(ownWorktree.path) === norm(folder)) ||
      (!!ownWorktree.branch && ownWorktree.branch === pr.head))
  return ownsHead ? 'mine' : 'foreign'
}

/**
 * Folders a forced refresh arrived for while a lookup was already running.
 * That lookup may have started before the pull request existed, so its
 * answer is followed by one more.
 */
const again = new Set<string>()
/** The session a pending lookup for a folder is to be claimed for. */
const claimants = new Map<string, string>()

export const usePrStatusStore = create<PrStatusState>()(
  persist(
  (set, get) => ({
  byFolder: {},
  claims: {},
  backfilled: false,
  addClaims: (add) => set((s) => ({ claims: { ...add, ...s.claims } })),
  markBackfilled: () => set({ backfilled: true }),
  refresh: async (folder, force = false, claimant) => {
    if (claimant) claimants.set(folder, claimant)
    const cur = get().byFolder[folder]
    if (cur?.loading) {
      if (force) again.add(folder)
      return
    }
    if (!force && cur && Date.now() - cur.at < FRESH_MS) return
    set((s) => ({
      byFolder: { ...s.byFolder, [folder]: { lookup: cur?.lookup ?? null, at: cur?.at ?? 0, loading: true } },
    }))
    let lookup: PrLookup
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      lookup = await invoke<PrLookup>('agent_pr_status', { project: folder })
    } catch (e) {
      lookup = { kind: 'failed', message: String(e) }
    }
    const repeat = again.delete(folder)
    const by = repeat ? undefined : claimants.get(folder)
    if (!repeat) claimants.delete(folder)
    set((s) => {
      const byFolder = { ...s.byFolder, [folder]: { lookup, at: Date.now(), loading: false } }
      if (!by || lookup.kind !== 'found') return { byFolder }
      const key = claimKey(folder, lookup.pr.number)
      if (s.claims[key]) return { byFolder }
      return { byFolder, claims: { ...s.claims, [key]: by } }
    })
    if (repeat) await get().refresh(folder, true)
  },
  }),
  {
    name: 'flint-pr-claims',
    // The Rust settings store, like the sessions, so claims survive a
    // cleared webview store. Rehydrated in hydrateBackendStores().
    storage: createJSONStorage(() => backendStorage),
    skipHydration: true,
    partialize: (s) =>
      ({ claims: s.claims, backfilled: s.backfilled }) as unknown as PrStatusState,
  }
  )
)

/**
 * The pull request for `folder`'s current branch and how `sessionId` relates
 * to it (see `prRelation`), or null when there is none or another session
 * claimed it.
 */
export function usePrStatusView(
  folder: string | null | undefined,
  sessionId?: string | null
): { pr: PrStatus; relation: 'mine' | 'foreign' } | null {
  const entry = usePrStatusStore((s) => (folder ? s.byFolder[folder] : undefined))
  const claims = usePrStatusStore((s) => s.claims)
  const ownWorktree = useCoworkWorktrees((s) =>
    sessionId ? s.bySession[sessionId] : undefined
  )
  useEffect(() => {
    if (!folder || !isPlatformTauri()) return
    void usePrStatusStore.getState().refresh(folder)
  }, [folder])
  if (!folder || entry?.lookup?.kind !== 'found') return null
  const pr = entry.lookup.pr
  const relation = prRelation(pr, folder, claims, sessionId, ownWorktree)
  return relation === 'hidden' ? null : { pr, relation }
}

/**
 * The pull request this session owns for `folder`'s current branch, or null:
 * also null when another session claimed it, or when it was opened outside
 * Flint and this session only shares the checkout.
 */
export function usePrStatus(
  folder: string | null | undefined,
  sessionId?: string | null
): PrStatus | null {
  const view = usePrStatusView(folder, sessionId)
  return view?.relation === 'mine' ? view.pr : null
}
