'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { resolveTarget } = require('./platform')

const pkg = require('../package.json')
const vendorDir = path.join(__dirname, '..', 'vendor')

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'flint-npm-installer' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirects === 0) return reject(new Error('too many redirects'))
          return resolve(download(res.headers.location, dest, redirects - 1))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`download failed: HTTP ${res.statusCode} for ${url}`))
        }
        const out = fs.createWriteStream(dest)
        res.pipe(out)
        out.on('finish', () => out.close(resolve))
        out.on('error', reject)
      })
      .on('error', reject)
  })
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function extract(archive, ext, dest) {
  // bsdtar ships with Windows 10+ and handles zip; tar handles tar.gz elsewhere.
  const args = ext === 'zip' ? ['-xf', archive, '-C', dest] : ['-xzf', archive, '-C', dest]
  const res = spawnSync('tar', args, { stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`could not extract ${archive}`)
}

async function main() {
  if (process.env.FLINT_SKIP_DOWNLOAD) return
  const meta = pkg.flintBinary
  if (!meta || !meta.tag) {
    console.warn('flint: this package was not built for a release; skipping the binary download')
    return
  }
  const target = resolveTarget()
  if (!target) {
    throw new Error(`flint: no published build for ${process.platform} ${process.arch}`)
  }
  const asset = meta.assets[target.target]
  if (!asset) throw new Error(`flint: release ${meta.tag} has no build for ${target.target}`)

  const url = `https://github.com/${meta.repo}/releases/download/${meta.tag}/${asset.name}`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-npm-'))
  try {
    const archive = path.join(tmp, asset.name)
    await download(url, archive)
    const actual = sha256(archive)
    if (actual !== asset.sha256) {
      throw new Error(`flint: checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}`)
    }
    extract(archive, target.ext, tmp)
    fs.mkdirSync(vendorDir, { recursive: true })
    const dest = path.join(vendorDir, target.bin)
    fs.copyFileSync(path.join(tmp, target.bin), dest)
    fs.chmodSync(dest, 0o755)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
