// Builds the website's image derivatives from the repo's real sources.
//   docs/screenshots/*.png      -> public/shots/<id>-<width>.{avif,webp}  (+ src/generated/shots.json)
//   src-tauri/icons/icon.png    -> public/brand/*  (resize/trim only, never redrawn)
// Sources stay the single source of truth; derivatives are generated and git-ignored.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = path.dirname(fileURLToPath(import.meta.url))
const site = path.resolve(here, '..')
const repo = path.resolve(site, '..')
const shotsSrc = path.join(repo, 'docs/screenshots')
const iconSrc = path.join(repo, 'src-tauri/icons/icon.png')
const shotsOut = path.join(site, 'public/shots')
const brandOut = path.join(site, 'public/brand')
const genOut = path.join(site, 'src/generated')
const WIDTHS = [800, 1280, 1920, 2560, 3200]

for (const d of [shotsOut, brandOut, genOut]) fs.mkdirSync(d, { recursive: true })

const fresh = (out, src) => fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs

const manifest = {}
const files = fs.readdirSync(shotsSrc).filter((f) => f.endsWith('.png')).sort()
for (const f of files) {
  const id = f.replace(/\.png$/, '')
  const src = path.join(shotsSrc, f)
  const meta = await sharp(src).metadata()
  const widths = WIDTHS.filter((w) => w <= meta.width)
  if (!widths.includes(meta.width) && meta.width < WIDTHS[0]) widths.push(meta.width)
  manifest[id] = { width: meta.width, height: meta.height, widths }
  for (const w of widths) {
    const avif = path.join(shotsOut, `${id}-${w}.avif`)
    const webp = path.join(shotsOut, `${id}-${w}.webp`)
    if (!fresh(avif, src)) await sharp(src).resize({ width: w }).avif({ quality: 72, effort: 4, chromaSubsampling: '4:4:4' }).toFile(avif)
    if (!fresh(webp, src)) await sharp(src).resize({ width: w }).webp({ quality: 90, effort: 5, smartSubsample: true }).toFile(webp)
  }
}
fs.writeFileSync(path.join(genOut, 'shots.json'), JSON.stringify(manifest, null, 2))
console.log(`assets: ${files.length} screenshots`)

// Brand: the actual executable icon. Transparent margins are trimmed so it fills its box; nothing else changes.
const trimmed = await sharp(iconSrc).trim({ threshold: 1 }).toBuffer()
const tm = await sharp(trimmed).metadata()
const side = Math.max(tm.width, tm.height)
const square = await sharp(trimmed)
  .extend({
    top: Math.floor((side - tm.height) / 2),
    bottom: Math.ceil((side - tm.height) / 2),
    left: Math.floor((side - tm.width) / 2),
    right: Math.ceil((side - tm.width) / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .toBuffer()
for (const n of [32, 64, 128, 256, 512]) {
  await sharp(square).resize(n, n, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(path.join(brandOut, `icon-${n}.png`))
}
// Platform icons that cannot be transparent sit on the app's dark background.
const onDark = async (n, inner) => {
  const mark = await sharp(square).resize(inner, inner).toBuffer()
  return sharp({ create: { width: n, height: n, channels: 4, background: '#0A0B0D' } })
    .composite([{ input: mark, gravity: 'center' }])
    .png()
    .toBuffer()
}
fs.writeFileSync(path.join(brandOut, 'apple-touch-icon.png'), await onDark(180, 124))
fs.writeFileSync(path.join(brandOut, 'icon-192.png'), await onDark(192, 132))
fs.writeFileSync(path.join(brandOut, 'icon-512-maskable.png'), await onDark(512, 340))

// favicon.ico: an ICO container holding the 32px PNG.
const png32 = fs.readFileSync(path.join(brandOut, 'icon-32.png'))
const header = Buffer.alloc(22)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)
header.writeUInt8(32, 6)
header.writeUInt8(32, 7)
header.writeUInt16LE(1, 10)
header.writeUInt16LE(32, 12)
header.writeUInt32LE(png32.length, 14)
header.writeUInt32LE(22, 18)
fs.writeFileSync(path.join(brandOut, 'favicon.ico'), Buffer.concat([header, png32]))
console.log('assets: brand icons')
