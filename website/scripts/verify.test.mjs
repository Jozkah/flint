// Checks the built site (run `npm run build` first). These are the invariants the brief cares about:
// real screenshots only, the real icon only, no dead anchors or duplicate ids, honest copy.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(site, '..')
const dist = path.join(site, 'dist')
const base = (process.env.SITE_BASE ?? '/flint/').replace(/\/?$/, '/')

assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'dist/index.html is missing: run `npm run build` before `npm test`')
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
const visible = text.replace(/<[^>]+>/g, ' ')

const toFile = (url) => {
  const u = url.split('#')[0].split('?')[0]
  if (!u.startsWith(base)) return null
  return path.join(dist, u.slice(base.length))
}

test('every local asset the page references exists', () => {
  const urls = new Set()
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) urls.add(m[1])
  for (const m of html.matchAll(/(?:srcset|imagesrcset)="([^"]+)"/g)) for (const part of m[1].split(',')) urls.add(part.trim().split(/\s+/)[0])
  const missing = [...urls].filter((u) => u.startsWith(base)).filter((u) => !fs.existsSync(toFile(u)))
  assert.deepEqual(missing, [])
  assert.ok(urls.size > 50)
})

test('ids are unique and every in-page anchor resolves', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  assert.deepEqual(dupes, [])
  const anchors = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]).filter(Boolean)
  const broken = anchors.filter((a) => !ids.includes(a))
  assert.deepEqual([...new Set(broken)], [])
})

test('there is one h1, headings do not skip levels, and every image has alt text', () => {
  const heads = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]))
  assert.equal(heads.filter((h) => h === 1).length, 1)
  for (let i = 1; i < heads.length; i++) assert.ok(heads[i] - heads[i - 1] <= 1, `heading jump ${heads[i - 1]} to ${heads[i]}`)
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0])
  assert.ok(imgs.length > 20)
  assert.deepEqual(imgs.filter((i) => !/\salt=/.test(i)), [])
  assert.deepEqual(imgs.filter((i) => /<img\b[^>]*\ssrc="[^"]*shots\/[^"]*"/.test(i) && !/\swidth=/.test(i) && !/\sheight=/.test(i)), [])
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
  assert.ok(fs.readFileSync(path.join(site, 'scripts/assets.mjs'), 'utf8').includes("src-tauri/icons/icon.png"))
  // The legacy vector mark must not be used anywhere in the site.
  const all = [html, ...fs.readdirSync(path.join(site, 'src'), { recursive: true }).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => fs.readFileSync(path.join(site, 'src', f), 'utf8'))].join('\n')
  assert.ok(!/flint-logo\.svg/.test(all))
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

test('copy states the licence correctly and makes no invented claims', () => {
  assert.match(visible, /Apache License 2\.0/)
  assert.doesNotMatch(visible, /\bMIT\b/)
  assert.doesNotMatch(visible, /lorem ipsum/i)
  for (const w of ['revolutioni', 'unlock', 'supercharge', 'next-generation', 'seamless', 'game-changing', 'AI-powered future', 'cutting-edge']) {
    assert.ok(!visible.toLowerCase().includes(w.toLowerCase()), `banned word: ${w}`)
  }
  assert.doesNotMatch(visible, /\b\d[\d,.]*\s*(?:stars|users|downloads|customers)\b/i)
})

test('SEO basics are in place', () => {
  assert.match(html, /<title>[^<]{10,}<\/title>/)
  assert.match(html, /<meta\s+name="description"\s+content="[^"]{60,}"/)
  assert.match(html, /<link rel="canonical" href="https?:\/\/[^"]+"/)
  assert.match(html, /property="og:image" content="https?:\/\/[^"]+og\.png"/)
  assert.match(html, /name="twitter:card"/)
  assert.match(html, /application\/ld\+json/)
  assert.ok(fs.existsSync(path.join(dist, 'robots.txt')))
  assert.ok(fs.existsSync(path.join(dist, 'sitemap.xml')))
  assert.ok(fs.existsSync(path.join(dist, 'og.png')))
})

test('download links point at real release assets or the latest release page', () => {
  const urls = [...html.matchAll(/href="(https:\/\/github\.com\/Jozkah\/flint\/releases\/[^"]+)"/g)].map((m) => m[1])
  assert.ok(urls.length > 0)
  for (const u of urls) assert.match(u, /^https:\/\/github\.com\/Jozkah\/flint\/releases\/(latest|tag\/|download\/|$)/)
})
