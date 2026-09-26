import { listEvents, type EventEnvelope } from '@/lib/eventLog'
import { claimKey, usePrStatusStore } from '@/stores/pr-status-store'

/**
 * Claims for pull requests opened before claims existed.
 *
 * Once per install, reads each Cowork session's event log for successful
 * pull-request creates -- a `git` tool call running `gh pr create`, or an MCP
 * `create_pull_request` tool -- and claims the pull request its output names
 * for that session. Session 8411d403 opened PR #31 before this, so without it
 * every session on the KewScraper checkout kept showing #31 as its own.
 */

export type BackfillSession = {
  id: string
  folder: string | null
  /** The session's own worktree, when it has one. */
  worktreePath?: string | null
}

const PR_URL = /https:\/\/github\.com\/[^/\s"]+\/[^/\s"]+\/pull\/(\d+)/

/** The pull-request number a create event opened, or null. */
export function createdPrNumber(event: EventEnvelope): number | null {
  if (event.kind !== 'tool.succeeded') return null
  const tool = String(event.payload.tool ?? '')
  const output = String(event.payload.output ?? '')
  const isCreate =
    (tool === 'git' && /^\$ gh pr create\b/.test(output)) ||
    /create_pull_request|pull_request_create/.test(tool)
  if (!isCreate) return null
  const m = PR_URL.exec(output)
  return m ? Number(m[1]) : null
}

type ListEvents = typeof listEvents

/** `folder#number` to session id for every create in these sessions' logs. */
export async function collectPrClaims(
  sessions: BackfillSession[],
  list: ListEvents = listEvents
): Promise<Record<string, string>> {
  const found: { key: string; session: string; at: string }[] = []
  for (const s of sessions) {
    const folders = [s.folder, s.worktreePath].filter((f): f is string => !!f)
    if (folders.length === 0) continue
    let after = 0
    for (;;) {
      let page
      try {
        page = await list(s.id, after)
      } catch {
        break // An unreadable log only means no claims from it.
      }
      for (const e of page.events) {
        const n = createdPrNumber(e)
        if (n === null) continue
        for (const f of folders) found.push({ key: claimKey(f, n), session: s.id, at: e.at })
      }
      if (!page.truncated || page.lastSeq <= after) break
      after = page.lastSeq
    }
  }
  // The earliest create of a pull request is the one that opened it.
  found.sort((a, b) => a.at.localeCompare(b.at))
  const claims: Record<string, string> = {}
  for (const f of found) claims[f.key] ??= f.session
  return claims
}

/** Run the backfill unless it already ran. Never throws. */
export async function backfillPrClaims(
  sessions: BackfillSession[],
  list: ListEvents = listEvents
): Promise<void> {
  if (usePrStatusStore.getState().backfilled) return
  try {
    usePrStatusStore.getState().addClaims(await collectPrClaims(sessions, list))
    usePrStatusStore.getState().markBackfilled()
  } catch (e) {
    console.warn('PR claim backfill failed', e)
  }
}
