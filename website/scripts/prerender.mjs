// Prerenders the homepage into dist/index.html and writes robots.txt, sitemap.xml and the Pages helpers.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(site, 'dist')
const base = (process.env.SITE_BASE ?? '/flint/').replace(/\/?$/, '/')
const siteUrl = (process.env.SITE_URL ?? 'https://jozkah.github.io/flint/').replace(/\/?$/, '/')

const { render } = await import(pathToFileURL(path.join(site, 'dist-ssr/entry-server.js')).href)
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

let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
if (!html.includes('<!--app-html-->')) throw new Error('dist/index.html has no <!--app-html--> marker')
html = html.replace('<!--app-html-->', render()).replace('<!--head-tags-->', headTags)
fs.writeFileSync(path.join(dist, 'index.html'), html)
fs.copyFileSync(path.join(dist, 'index.html'), path.join(dist, '404.html'))

fs.writeFileSync(path.join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`)
fs.writeFileSync(
  path.join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}</loc></url>\n</urlset>\n`,
)
fs.writeFileSync(path.join(dist, '.nojekyll'), '')
fs.rmSync(path.join(site, 'dist-ssr'), { recursive: true, force: true })
console.log(`prerender: ${html.length} bytes, base ${base}`)
