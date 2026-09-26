import { useEffect } from 'react'
import { create } from 'zustand'
import { isPlatformTauri } from '@/lib/platform/utils'

/**
 * Pull-request status per project folder, read through the GitHub CLI by the
 * `agent_pr_status` command. Nothing is stored between launches and no token
 * is kept: when `gh` is missing or signed out the lookup says so and the UI
 * shows no pull-request marks.
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
  refresh: (folder: string, force?: boolean) => Promise<void>
}

/**
 * Folders a forced refresh arrived for while a lookup was already running.
 * That lookup may have started before the pull request existed, so its
 * answer is followed by one more.
 */
const again = new Set<string>()

export const usePrStatusStore = create<PrStatusState>()((set, get) => ({
  byFolder: {},
  refresh: async (folder, force = false) => {
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
    set((s) => ({
      byFolder: { ...s.byFolder, [folder]: { lookup, at: Date.now(), loading: false } },
    }))
    if (again.delete(folder)) await get().refresh(folder, true)
  },
}))

/** The pull request for `folder`'s current branch, or null. */
export function usePrStatus(folder: string | null | undefined): PrStatus | null {
  const entry = usePrStatusStore((s) => (folder ? s.byFolder[folder] : undefined))
  useEffect(() => {
    if (!folder || !isPlatformTauri()) return
    void usePrStatusStore.getState().refresh(folder)
  }, [folder])
  return entry?.lookup?.kind === 'found' ? entry.lookup.pr : null
}
