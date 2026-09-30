// Packages a FLAT build (VITE_FLAT=1 SITE_BASE=./ npm run build) as a self-contained preview folder:
// every page is one HTML file with its CSS, JavaScript and fonts inlined, next to shots/ and brand/.
// Used to host the site somewhere that only allows inline code (for example a claude.ai artifact).
//   node scripts/artifact.mjs <out-dir>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(site, 'dist')
const out = path.resolve(process.argv[2] ?? path.join(site, 'dist-preview'))
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('run the flat build first')

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const assets = path.join(dist, 'assets')
const css0 = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find((f) => f.endsWith('.css'))), 'utf8')
const js = fs.readFileSync(path.join(assets, fs.readdirSync(assets).find((f) => f.endsWith('.js'))), 'utf8').replace(/<\/script/gi, '<\\/script')
const font = (w) => `data:font/woff2;base64,${fs.readFileSync(path.join(dist, `fonts/inter-${w}.woff2`)).toString('base64')}`
const css = css0.replace(/url\((?:\.\.\/|\.\/|\/)?fonts\/inter-(\d+)\.woff2\)/g, (_, w) => `url(${font(w)})`)
if (/fonts\/inter-/.test(css)) throw new Error('a font URL was not inlined')

const pages = fs.readdirSync(dist).filter((f) => f.endsWith('.html'))
for (const f of pages) {
  let html = fs.readFileSync(path.join(dist, f), 'utf8')
  html = html
    .replace(/<link rel="preload"[^>]*as="font"[^>]*>/g, '')
    .replace(/<link rel="modulepreload"[^>]*>/g, '')
    .replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${css}</style>`)
    .replace(/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/, () => `<script type="module">${js}</script>`)
  if (!html.includes('<style>') || !html.includes('<script type="module">')) throw new Error(`${f}: inlining failed`)
  fs.writeFileSync(path.join(out, f), html)
}

// The entry page is published through a host that wraps it in its own document, so it needs content only.
const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8')
const title = home.match(/<title>[\s\S]*?<\/title>/)[0]
const style = home.match(/<style>[\s\S]*?<\/style>/)[0]
const headScripts = [...home.match(/<head>[\s\S]*<\/head>/)[0].matchAll(/<script>[\s\S]*?<\/script>/g)].map((m) => m[0]).join('\n')
const body = home.match(/<body>([\s\S]*)<\/body>/)[1]
fs.writeFileSync(path.join(out, 'entry.html'), `${title}\n${style}\n${headScripts}\n${body}`)

for (const dir of ['brand']) fs.cpSync(path.join(dist, dir), path.join(out, dir), { recursive: true })
fs.copyFileSync(path.join(dist, 'og.png'), path.join(out, 'og.png'))
fs.mkdirSync(path.join(out, 'shots'))
for (const f of fs.readdirSync(path.join(dist, 'shots'))) if (f.endsWith('.avif')) fs.copyFileSync(path.join(dist, 'shots', f), path.join(out, 'shots', f))

const count = (d) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length
console.log(`artifact: ${pages.length} pages, ${count(out)} files in ${out}`)
