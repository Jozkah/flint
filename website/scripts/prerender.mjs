// Prerenders every page into dist/<path>/index.html (plus 404.html) and writes robots.txt, sitemap.xml and the Pages helpers.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(site, 'dist')
const base = (process.env.SITE_BASE ?? '/flint/').replace(/\/?$/, '/')
const siteUrl = (process.env.SITE_URL ?? 'https://jozkah.github.io/flint/').replace(/\/?$/, '/')

const { render, pages } = await import(pathToFileURL(path.join(site, 'dist-ssr/entry-server.js')).href)
const shots = JSON.parse(fs.readFileSync(path.join(site, 'src/generated/shots.json'), 'utf8'))
const release = JSON.parse(fs.readFileSync(path.join(site, 'src/generated/release.json'), 'utf8'))

const hero = shots['01-overview']
const srcset = hero.widths.map((w) => `${base}shots/01-overview-${w}.avif ${w}w`).join(', ')
const preload = `<link rel="preload" as="image" type="image/avif" imagesrcset="${srcset}" imagesizes="(min-width: 960px) 1480px, 92vw" fetchpriority="high" />`

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Flint',
  description: 'A private, local-first AI workspace for your desktop: chat with local or remote models, let Cowork agents work on real projects, and review every change before it applies.',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Windows, macOS, Linux',
  url: siteUrl,
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  downloadUrl: release.url,
  ...(release.tag ? { softwareVersion: release.tag.replace(/^v/, '') } : {}),
  image: `${siteUrl}og.png`,
  codeRepository: 'https://github.com/Jozkah/flint',
}
const headTags = `${preload}\n    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`

const template = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
if (!template.includes('<!--app-html-->')) throw new Error('dist/index.html has no <!--app-html--> marker')

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const meta = (html, page) => {
  const url = page.path && page.path !== '404' ? `${siteUrl}${page.path}/` : siteUrl
  const set = (re, val) => {
    if (!re.test(html)) throw new Error(`template is missing ${re}`)
    html = html.replace(re, `$1${esc(val)}$2`)
  }
  set(/(<title>)[^<]*(<\/title>)/, page.title)
  set(/(<meta\s+name="description"\s+content=")[^"]*(")/, page.description)
  set(/(<link rel="canonical" href=")[^"]*(")/, url)
  set(/(<meta property="og:url" content=")[^"]*(")/, url)
  set(/(<meta property="og:title" content=")[^"]*(")/, page.title)
  set(/(<meta name="twitter:title" content=")[^"]*(")/, page.title)
  set(/(<meta\s+property="og:description"\s+content=")[^"]*(")/, page.description)
  set(/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/, page.description)
  return html
}

const written = []
for (const page of pages) {
  const isHome = page.path === ''
  const is404 = page.path === '404'
  let html = isHome ? template : meta(template, page)
  const extra = isHome ? headTags : is404 ? '<meta name="robots" content="noindex" />' : ''
  html = html.replace('<div id="root">', `<div id="root" data-page="${page.path}">`).replace('<!--app-html-->', render(is404 ? '__not-found__' : page.path)).replace('<!--head-tags-->', extra)
  const file = is404 ? path.join(dist, '404.html') : path.join(dist, page.path, 'index.html')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, html)
  written.push(`${page.path || '/'} (${html.length})`)
}

fs.writeFileSync(path.join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`)
fs.writeFileSync(
  path.join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .filter((p) => p.path !== '404')
    .map((p) => `  <url><loc>${siteUrl}${p.path ? `${p.path}/` : ''}</loc></url>`)
    .join('\n')}\n</urlset>\n`,
)
fs.writeFileSync(path.join(dist, '.nojekyll'), '')
fs.rmSync(path.join(site, 'dist-ssr'), { recursive: true, force: true })
console.log(`prerender: ${written.length} pages, base ${base}: ${written.join(', ')}`)
