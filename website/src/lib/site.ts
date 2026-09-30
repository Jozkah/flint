import release from '../generated/release.json'

declare const __SITE_URL__: string

export const SITE_URL: string = typeof __SITE_URL__ === 'undefined' ? 'https://jozkah.github.io/flint/' : __SITE_URL__
export const BASE: string = import.meta.env.BASE_URL
export const asset = (path: string) => `${BASE}${path.replace(/^\//, '')}`

export const REPO = 'https://github.com/Jozkah/flint'
export const LINKS = {
  repo: REPO,
  releases: `${REPO}/releases`,
  latest: `${REPO}/releases/latest`,
  docs: `${REPO}/tree/main/docs`,
  features: `${REPO}/blob/main/docs/FEATURES.md`,
  build: `${REPO}/blob/main/docs/BUILDING.md`,
  contributing: `${REPO}/blob/main/CONTRIBUTING.md`,
  issues: `${REPO}/issues`,
  license: `${REPO}/blob/main/LICENSE`,
  jan: 'https://github.com/janhq/jan',
  llamacpp: 'https://github.com/ggerganov/llama.cpp',
  tauri: 'https://tauri.app/',
  scalar: 'https://github.com/scalar/scalar',
} as const

export type OS = 'windows' | 'macos' | 'linux'
export const OS_LABEL: Record<OS, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }

export type ReleaseAsset = { label: string; name: string; url: string; size: number }
export type Release = {
  tag: string | null
  name: string | null
  url: string
  published: string | null
  assets: Record<OS, ReleaseAsset[]>
}
export const RELEASE = release as unknown as Release

/** Best-effort client-side OS hint. Reads the browser's own platform string; nothing is sent anywhere. */
export function detectOS(): OS | null {
  if (typeof navigator === 'undefined') return null
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const p = `${nav.userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase()
  if (/iphone|ipad|android/.test(p)) return null
  if (p.includes('win')) return 'windows'
  if (p.includes('mac')) return 'macos'
  if (p.includes('linux') || p.includes('x11')) return 'linux'
  return null
}

export const mb = (n: number) => `${Math.round(n / 1048576)} MB`
