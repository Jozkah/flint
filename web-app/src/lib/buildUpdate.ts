/**
 * Whether a newer build of this release exists.
 *
 * Flint 0.9.0 is a nightly: the installers behind the release are rebuilt from
 * the latest code and the tag moves with them, so the version number never
 * changes. An installed copy therefore compares the commit it was built from
 * with the commit the release tag points at now. Nothing here runs unless the
 * person turned the check on or pressed Check now.
 */
export const RELEASES_URL = 'https://github.com/Jozkah/flint/releases/tag'
const TAG_COMMIT_URL = 'https://api.github.com/repos/Jozkah/flint/commits'

export type BuildCheck =
  | { state: 'current'; latest: string }
  | { state: 'newer'; latest: string }
  /** No commit was recorded in this build (a local or development build), or the lookup failed. */
  | { state: 'unknown'; latest?: string }

export function releaseTag(version: string): string {
  return `v${version}`
}

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/${releaseTag(version)}`
}

/** The commit the release tag points at, or null when it cannot be read. */
export async function fetchTagCommit(
  version: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const res = await fetchFn(`${TAG_COMMIT_URL}/${releaseTag(version)}`, {
      headers: { Accept: 'application/vnd.github.sha' },
      signal,
    })
    if (!res.ok) return null
    const sha = (await res.text()).trim()
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null
  } catch {
    return null
  }
}

export function compareBuild(built: string, latest: string | null): BuildCheck {
  if (!latest) return { state: 'unknown' }
  const own = built.trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(own)) return { state: 'unknown', latest }
  // A build may carry a short hash; the tag lookup is always the full one.
  return latest.startsWith(own) || own.startsWith(latest)
    ? { state: 'current', latest }
    : { state: 'newer', latest }
}

export async function checkForNewerBuild(
  built: string,
  version: string,
  fetchFn?: typeof fetch,
  signal?: AbortSignal
): Promise<BuildCheck> {
  return compareBuild(built, await fetchTagCommit(version, fetchFn, signal))
}
