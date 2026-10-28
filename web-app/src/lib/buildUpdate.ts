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

/**
 * Update channels. Release is the stable line above. Beta is any non-nightly
 * prerelease or semver pre-release tag (v1.2.0-beta.1); the picker hides it
 * until one exists. Nightly is the `nightly-YYYYMMDD-HH` prerelease the release
 * workflow publishes. Flint installs nothing itself: every choice opens the
 * release page, where the person downloads the installer.
 */
export type Channel = 'release' | 'beta' | 'nightly'
export const CHANNELS: Channel[] = ['release', 'beta', 'nightly']

export type ChannelRelease = {
  tag: string
  /** Semver for release and beta; the tag for nightlies, which carry no version of their own. */
  version: string
  channel: Channel
  url: string
  publishedAt: number
  /** The commit a nightly was built from (its target), used to tell which nightly is installed. */
  commit: string
}

/** Where a release sits relative to the installed build. */
export type Direction = 'newer' | 'older' | 'installed' | 'unknown'

const RELEASES_API = 'https://api.github.com/repos/Jozkah/flint/releases?per_page=60'

export function channelOf(tag: string, prerelease: boolean): Channel | null {
  if (/^nightly-/i.test(tag)) return 'nightly'
  const parsed = parseVersion(tag)
  if (!parsed) return null
  return prerelease || parsed.pre.length ? 'beta' : 'release'
}

/** Every published release in a GitHub releases payload, newest first. Drafts and odd tags are skipped. */
export function parseReleases(payload: unknown): ChannelRelease[] {
  const items = Array.isArray(payload) ? payload : [payload]
  const out: ChannelRelease[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (r.draft === true || typeof r.tag_name !== 'string') continue
    const tag = r.tag_name.trim()
    const channel = channelOf(tag, r.prerelease === true)
    if (!channel) continue
    const version = channel === 'nightly' ? tag : tag.replace(/^v/, '')
    const url =
      typeof r.html_url === 'string' && r.html_url.startsWith('https://github.com/Jozkah/flint/')
        ? r.html_url
        : `${RELEASES_URL}/${tag}`
    const published = Date.parse(typeof r.published_at === 'string' ? r.published_at : '')
    out.push({
      tag,
      version,
      channel,
      url,
      publishedAt: Number.isNaN(published) ? 0 : published,
      commit: typeof r.target_commitish === 'string' ? r.target_commitish : '',
    })
  }
  return out.sort((a, b) => b.publishedAt - a.publishedAt)
}

/** All recent releases, or null when they cannot be read. */
export async function fetchReleases(
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<ChannelRelease[] | null> {
  try {
    const res = await fetchFn(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal,
    })
    if (!res.ok) return null
    return parseReleases(await res.json())
  } catch {
    return null
  }
}

/**
 * The release the running build came from: a nightly whose target commit is
 * the build commit, else the release or beta with the same version.
 */
export function findInstalled(
  list: ChannelRelease[],
  version: string,
  commit: string
): ChannelRelease | null {
  const sha = commit.trim().toLowerCase()
  if (sha.length >= 7) {
    const nightly = list.find(
      (r) => r.channel === 'nightly' && /^[0-9a-f]{7,40}$/i.test(r.commit) && sha.startsWith(r.commit.toLowerCase())
    )
    if (nightly) return nightly
  }
  return list.find((r) => r.channel !== 'nightly' && compareVersions(r.version, version) === 0) ?? null
}

/**
 * Release and beta builds compare by version. Anything involving a nightly
 * compares by publish date against the installed release, which has to be
 * found in the list; otherwise the direction is unknown.
 */
export function directionOf(
  entry: ChannelRelease,
  list: ChannelRelease[],
  version: string,
  commit: string
): Direction {
  const installed = findInstalled(list, version, commit)
  if (installed?.tag === entry.tag) return 'installed'
  if (entry.channel !== 'nightly' && installed?.channel !== 'nightly') {
    const order = compareVersions(entry.version, version)
    if (order === null) return 'unknown'
    return order > 0 ? 'newer' : order < 0 ? 'older' : 'installed'
  }
  if (!installed || !installed.publishedAt || !entry.publishedAt) return 'unknown'
  return entry.publishedAt > installed.publishedAt ? 'newer' : 'older'
}

/** Whether the newest release on a channel is newer than the installed build. */
export function checkChannel(
  list: ChannelRelease[] | null,
  channel: Channel,
  version: string,
  commit: string
): BuildCheck {
  if (!list) return { state: 'unknown' }
  const latest = list.find((r) => r.channel === channel)
  if (!latest) return { state: 'unknown' }
  const direction = directionOf(latest, list, version, commit)
  if (direction === 'unknown') return { state: 'unknown', latest: latest.version, url: latest.url }
  return {
    state: direction === 'newer' ? 'newer' : 'current',
    latest: latest.version,
    url: latest.url,
  }
}
