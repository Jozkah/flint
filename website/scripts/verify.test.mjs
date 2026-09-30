// Checks the built site (run `npm run build` first). These are the invariants the brief cares about:
// real screenshots only, the real icon only, no dead links or duplicate ids, honest copy, legal pages present.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(site, '..')
const dist = path.join(site, 'dist')
const base = (process.env.SITE_BASE ?? '/flint/').replace(/\/?$/, '/')
const siteUrl = (process.env.SITE_URL ?? 'https://jozkah.github.io/flint/').replace(/\/?$/, '/')

assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'dist/index.html is missing: run `npm run build` before `npm test`')

const PAGES = ['', 'docs', 'install', 'faq', 'changelog', 'privacy', 'terms', 'license', 'security-policy', 'accessibility', 'brand']
const pageFile = (p) => path.join(dist, p, 'index.html')
const read = (p) => fs.readFileSync(pageFile(p), 'utf8')
const html = read('')
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
const visibleOf = (h) => strip(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ')
const all = PAGES.map((p) => [p || 'home', read(p)])

const toFile = (url) => {
  const u = url.split('#')[0].split('?')[0]
  if (!u.startsWith(base)) return null
  const f = path.join(dist, u.slice(base.length))
  return fs.existsSync(f) && fs.statSync(f).isDirectory() ? path.join(f, 'index.html') : f
}

test('every page, plus 404, was prerendered', () => {
  for (const p of PAGES) assert.ok(fs.existsSync(pageFile(p)), `missing page: ${p || '/'}`)
  assert.ok(fs.existsSync(path.join(dist, '404.html')))
  assert.match(fs.readFileSync(path.join(dist, '404.html'), 'utf8'), /not here/)
})

test('every local asset and internal link exists', () => {
  for (const [name, h] of all) {
    const urls = new Set()
    for (const m of h.matchAll(/(?:src|href)="([^"]+)"/g)) urls.add(m[1])
    for (const m of h.matchAll(/(?:srcset|imagesrcset)="([^"]+)"/g)) for (const part of m[1].split(',')) urls.add(part.trim().split(/\s+/)[0])
    const missing = [...urls].filter((u) => u.startsWith(base)).filter((u) => !fs.existsSync(toFile(u)))
    assert.deepEqual(missing, [], `${name}: missing targets`)
  }
  assert.ok([...html.matchAll(/(?:src|href)="([^"]+)"/g)].length > 50)
})

test('ids are unique and every in-page anchor resolves, on every page', () => {
  const homeIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
  for (const [name, h] of all) {
    const ids = [...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `${name}: duplicate ids`)
    const anchors = [...h.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]).filter(Boolean)
    assert.deepEqual([...new Set(anchors.filter((a) => !ids.includes(a)))], [], `${name}: dead anchors`)
    const cross = [...h.matchAll(new RegExp(`href="${base}#([^"]+)"`, 'g'))].map((m) => m[1])
    assert.deepEqual([...new Set(cross.filter((a) => !homeIds.includes(a)))], [], `${name}: cross-page anchors`)
  }
})

test('each page has one h1, headings do not skip levels, and every image has alt text', () => {
  for (const [name, h] of all) {
    const heads = [...strip(h).matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]))
    assert.equal(heads.filter((x) => x === 1).length, 1, `${name}: h1 count`)
    for (let i = 1; i < heads.length; i++) assert.ok(heads[i] - heads[i - 1] <= 1, `${name}: heading jump ${heads[i - 1]} to ${heads[i]}`)
    const imgs = [...h.matchAll(/<img\b[^>]*>/g)].map((m) => m[0])
    assert.deepEqual(imgs.filter((i) => !/\salt=/.test(i)), [], `${name}: images without alt`)
    assert.deepEqual(imgs.filter((i) => !/\swidth=/.test(i) || !/\sheight=/.test(i)), [], `${name}: images without dimensions`)
  }
  assert.ok([...html.matchAll(/<img\b/g)].length > 20)
})

test('product screenshots come only from docs/screenshots', () => {
  const sources = new Set(fs.readdirSync(path.join(repo, 'docs/screenshots')).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, '')))
  const used = new Set([...html.matchAll(/shots\/([a-z0-9-]+?)-\d+\.(?:avif|webp)/g)].map((m) => m[1]))
  assert.ok(used.size >= 10)
  for (const id of used) assert.ok(sources.has(id), `${id} has no source in docs/screenshots`)
  for (const f of fs.readdirSync(path.join(dist, 'shots'))) assert.ok(sources.has(f.replace(/-\d+\.(avif|webp)$/, '')), `stray file ${f}`)
})

test('the Flint mark is the real executable icon', async () => {
  const src = path.join(repo, 'src-tauri/icons/icon.png')
  assert.ok(fs.existsSync(src))
  assert.ok(fs.readFileSync(path.join(site, 'scripts/assets.mjs'), 'utf8').includes('src-tauri/icons/icon.png'))
  // The legacy vector mark must not be used anywhere in the site.
  const code = fs.readdirSync(path.join(site, 'src'), { recursive: true }).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => fs.readFileSync(path.join(site, 'src', f), 'utf8'))
  assert.ok(![...all.map(([, h]) => h), ...code].join('\n').match(/flint-logo\.svg/))
  for (const n of [32, 64, 128, 256, 512]) assert.ok(fs.existsSync(path.join(dist, `brand/icon-${n}.png`)))
  assert.ok(fs.existsSync(path.join(dist, 'brand/favicon.ico')))
  // The derivative must equal a fresh trim + resize of the source, so a stale or substituted file fails.
  const { default: sharp } = await import('sharp')
  const trimmed = await sharp(src).trim({ threshold: 1 }).toBuffer()
  const tm = await sharp(trimmed).metadata()
  const side = Math.max(tm.width, tm.height)
  const square = await sharp(trimmed).extend({ top: Math.floor((side - tm.height) / 2), bottom: Math.ceil((side - tm.height) / 2), left: Math.floor((side - tm.width) / 2), right: Math.ceil((side - tm.width) / 2), background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer()
  const expected = await sharp(square).resize(512, 512, { kernel: 'lanczos3' }).raw().toBuffer()
  const actual = await sharp(path.join(dist, 'brand/icon-512.png')).raw().toBuffer()
  assert.ok(expected.equals(actual), 'brand/icon-512.png is not a plain resize of src-tauri/icons/icon.png')
})

test('copy states the licence correctly and makes no invented claims, on every page', () => {
  for (const [name, h] of all) {
    const v = visibleOf(h)
    assert.doesNotMatch(v, /\bMIT\b/, `${name}: mentions MIT`)
    assert.doesNotMatch(v, /lorem ipsum/i, `${name}: lorem ipsum`)
    for (const w of ['revolutioni', 'unlock', 'supercharge', 'next-generation', 'seamless', 'game-changing', 'AI-powered future', 'cutting-edge']) {
      assert.ok(!v.toLowerCase().includes(w), `${name}: banned word ${w}`)
    }
    assert.doesNotMatch(v, /\b\d[\d,.]*\s*(?:stars|users|downloads|customers)\b/i, `${name}: invented numbers`)
    assert.match(v, /Apache License 2\.0/, `${name}: footer should state the licence`)
  }
})

test('legal pages exist, say the right things, and are linked from every footer', () => {
  const v = (p) => visibleOf(read(p))
  assert.match(v('privacy'), /no telemetry/i)
  assert.match(v('privacy'), /keyring/i)
  assert.match(v('privacy'), /GitHub Pages/)
  assert.match(v('terms'), /Apache License 2\.0/)
  assert.match(v('terms'), /Copyright 2026 Jozkah/)
  assert.match(v('license'), /Menlo Research/)
  assert.match(v('license'), /Copyright 2026 Jozkah/)
  assert.match(v('security-policy'), /private vulnerability reporting/i)
  assert.match(v('security-policy'), /0\.9\.x/)
  assert.match(v('accessibility'), /screen-reader pass of the app has not been done/)
  for (const [name, h] of all) for (const p of ['privacy', 'terms', 'license', 'security-policy', 'accessibility']) assert.ok(h.includes(`href="${base}${p}/"`), `${name}: footer lacks ${p}`)
  // The pages must agree with the repository's own legal files.
  assert.match(fs.readFileSync(path.join(repo, 'LICENSE'), 'utf8'), /Apache License/)
  const notice = fs.readFileSync(path.join(repo, 'NOTICE'), 'utf8')
  assert.match(notice, /Copyright 2026 Jozkah/)
  assert.match(notice, /Menlo Research/)
  assert.match(fs.readFileSync(path.join(repo, 'SECURITY.md'), 'utf8'), /0\.9\.x/)
})

test('SEO basics are in place and each page is distinct', () => {
  const titles = new Set()
  const canon = new Set()
  for (const [name, h] of all) {
    const title = h.match(/<title>([^<]{10,})<\/title>/)?.[1]
    assert.ok(title, `${name}: title`)
    titles.add(title)
    assert.match(h, /<meta\s+name="description"\s+content="[^"]{50,}"/, `${name}: description`)
    const c = h.match(/<link rel="canonical" href="([^"]+)"/)?.[1]
    assert.ok(c?.startsWith(siteUrl), `${name}: canonical`)
    canon.add(c)
    assert.match(h, /property="og:image" content="https?:\/\/[^"]+og\.png"/, `${name}: og:image`)
    assert.match(h, /name="twitter:card"/, `${name}: twitter card`)
  }
  assert.equal(titles.size, PAGES.length)
  assert.equal(canon.size, PAGES.length)
  assert.match(html, /application\/ld\+json/)
  for (const f of ['robots.txt', 'sitemap.xml', 'og.png']) assert.ok(fs.existsSync(path.join(dist, f)), f)
  const sitemap = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8')
  for (const p of PAGES) assert.ok(sitemap.includes(`<loc>${siteUrl}${p ? `${p}/` : ''}</loc>`), `sitemap lacks ${p || '/'}`)
  assert.match(fs.readFileSync(path.join(dist, '404.html'), 'utf8'), /noindex/)
})

test('download links point at real release assets or the latest release page', () => {
  const urls = [...html.matchAll(/href="(https:\/\/github\.com\/Jozkah\/flint\/releases\/[^"]+)"/g)].map((m) => m[1])
  assert.ok(urls.length > 0)
  for (const u of urls) assert.match(u, /^https:\/\/github\.com\/Jozkah\/flint\/releases\/(latest|tag\/|download\/|$)/)
})
