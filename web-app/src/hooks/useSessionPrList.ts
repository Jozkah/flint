import {
  useFolderPrView,
  usePrStatusStore,
  useSessionPrs,
  type PrLookup,
  type PrStatus,
} from '@/stores/pr-status-store'

/**
 * Every pull request a Cowork session is shown: the ones it recorded (latest
 * first, with live status where read) and, before them, the one on its
 * folder's current branch when that is the session's own and not already
 * listed. The same store the pull-request bar and the sidebar mark read, so
 * a hover costs nothing beyond the lookups they already make (cached two
 * minutes per folder and per URL).
 */
/**
 * A lookup that simply means "this folder cannot have pull requests" (no
 * pull request, not a repository, or a repository with no remote): nothing
 * to show and nothing failed.
 */
function noPullRequestsPossible(lookup: PrLookup): boolean {
  if (lookup.kind === 'found' || lookup.kind === 'no_pull_request') return true
  if (lookup.kind === 'not_a_repository') return true
  return lookup.kind === 'failed' && NO_REMOTE.test(lookup.message)
}

/** git / gh wording for a repository without a remote to ask. */
const NO_REMOTE = /no (git )?remotes?\b|none of the git remotes|no remote (repository|configured)/i

export function useSessionPrList(
  sessionId: string | null | undefined,
  folder: string | null | undefined
): { prs: PrStatus[]; loading: boolean; error?: string } {
  const recorded = useSessionPrs(sessionId, folder)
  const view = useFolderPrView(folder, sessionId)
  const folderEntry = usePrStatusStore((s) => (folder ? s.byFolder[folder] : undefined))
  const byUrl = usePrStatusStore((s) => s.byUrl)

  const prs = [...recorded]
  if (view?.relation === 'mine' && !prs.some((p) => p.url === view.pr.url)) {
    prs.unshift(view.pr)
  }
  // Nothing known yet for a lookup still running: the folder's, or a recorded
  // pull request whose status was never read.
  const loading =
    (!!folderEntry?.loading && !folderEntry.lookup) ||
    recorded.some((p) => {
      const entry = byUrl[p.url]
      return !!entry?.loading && !entry.lookup
    })
  const lookup = folderEntry?.lookup
  const error =
    prs.length === 0 && lookup && !noPullRequestsPossible(lookup)
      ? lookup.kind === 'failed'
        ? lookup.message
        : lookup.kind
      : undefined
  return { prs, loading, error }
}
