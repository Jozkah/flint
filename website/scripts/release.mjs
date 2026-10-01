// Looks up the latest Flint release at build time, so the page never hardcodes a version or file name.
// Falls back to the generic /releases/latest page when offline or rate limited.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(site, 'src/generated/release.json')
fs.mkdirSync(path.dirname(out), { recursive: true })

const REPO = 'Jozkah/flint'
const LATEST = `https://github.com/${REPO}/releases/latest`
const fallback = { tag: null, name: null, url: LATEST, published: null, assets: { windows: [], macos: [], linux: [] } }

const kind = (n) => {
  if (/\.(exe)$/i.test(n)) return ['windows', 'Installer (.exe)', 0]
  if (/\.msi$/i.test(n)) return ['windows', 'MSI', 1]
  if (/\.dmg$/i.test(n)) return ['macos', 'Disk image (.dmg)', 0]
  if (/\.AppImage$/i.test(n)) return ['linux', 'AppImage', 0]
  if (/\.deb$/i.test(n)) return ['linux', '.deb', 1]
  return null
}

async function main() {
  if (process.env.SKIP_RELEASE_FETCH) return fallback
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'flint-website-build' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers, signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const rel = await res.json()
    const assets = { windows: [], macos: [], linux: [] }
    for (const a of rel.assets ?? []) {
      const k = kind(a.name)
      if (!k) continue
      assets[k[0]].push({ label: k[1], order: k[2], name: a.name, url: a.browser_download_url, size: a.size })
    }
    for (const list of Object.values(assets)) list.sort((x, y) => x.order - y.order)
    return { tag: rel.tag_name, name: rel.name, url: rel.html_url, published: rel.published_at, assets }
  } catch (e) {
    console.warn(`release: lookup failed (${e.message}); using ${LATEST}`)
    return fallback
  }
}

const data = await main()
fs.writeFileSync(out, JSON.stringify(data, null, 2))
console.log(`release: ${data.tag ?? 'fallback'}`)
