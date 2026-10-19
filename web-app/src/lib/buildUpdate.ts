/**
 * Whether a newer stable Flint release exists.
 *
 * The target is always the newest stable release of Jozkah/flint: GitHub's
 * "latest" release, which is never a draft or a prerelease. Nightlies are
 * prereleases, so they are never offered. Versions are compared as semver; an
 * installed build that is equal to or ahead of the latest stable (a nightly or
 * a dev build) counts as up to date. Nothing here runs unless the person
 * turned the check on or pressed Check now.
 */
export const RELEASES_URL = 'https://github.com/Jozkah/flint/releases/tag'
const LATEST_RELEASE_API = 'https://api.github.com/repos/Jozkah/flint/releases/latest'

export type StableRelease = { version: string; url: string }

export type BuildCheck =
  /** Installed version equals or is ahead of the latest stable release. */
  | { state: 'current'; latest: string; url: string }
  | { state: 'newer'; latest: string; url: string }
  /** The release could not be read (offline, rate limited, no release) or the installed version is unreadable. */
  | { state: 'unknown'; latest?: string; url?: string }

type Parsed = { core: [number, number, number]; pre: string[] }

export function parseVersion(raw: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** Semver order: negative when a < b. A pre-release sorts below its release. Null when either is unreadable. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

export function releaseTag(version: string): string {
  return `v${version.replace(/^v/, '')}`
}

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/${releaseTag(version)}`
}

/**
 * The newest stable release in a GitHub releases payload (one object from
 * /releases/latest or an array from /releases). Drafts, prereleases and
 * anything tagged nightly are skipped, wherever they sit in a list.
 */
export function pickStable(payload: unknown): StableRelease | null {
  const items = Array.isArray(payload) ? payload : [payload]
  let best: StableRelease | null = null
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const r = item as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }
    if (r.draft === true || r.prerelease === true) continue
    if (typeof r.tag_name !== 'string' || /nightly/i.test(r.tag_name)) continue
    const parsed = parseVersion(r.tag_name)
    if (!parsed || parsed.pre.length) continue
    const version = r.tag_name.trim().replace(/^v/, '')
    const url =
      typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/Jozkah/flint/')
        ? r.html_url
        : releaseUrl(version)
    if (!best || (compareVersions(best.version, version) ?? 0) < 0) best = { version, url }
  }
  return best
}

/** The latest stable release, or null when it cannot be read (404, rate limit, offline, odd body). */
export async function fetchLatestStable(
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<StableRelease | null> {
  try {
    const res = await fetchFn(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal,
    })
    if (!res.ok) return null
    return pickStable(await res.json())
  } catch {
    return null
  }
}

export function compareRelease(installed: string, latest: StableRelease | null): BuildCheck {
  if (!latest) return { state: 'unknown' }
  const order = compareVersions(installed, latest.version)
  if (order === null) return { state: 'unknown', latest: latest.version, url: latest.url }
  return { state: order < 0 ? 'newer' : 'current', latest: latest.version, url: latest.url }
}

export async function checkForNewerBuild(
  installed: string,
  fetchFn?: typeof fetch,
  signal?: AbortSignal
): Promise<BuildCheck> {
  return compareRelease(installed, await fetchLatestStable(fetchFn, signal))
}
