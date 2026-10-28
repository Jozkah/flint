// scripts/download.js
import https from 'https'
import fs, { mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import unzipper from 'unzipper'
import tar from 'tar'
import { installSidecar, pickSqliteVecLibrary, sqliteVecLibName } from './download-bin-install.mjs'
import { assertSafeTarEntry, assertSafeZipEntry } from './archive-extract-guard.mjs'
import { execFileSync } from 'child_process'
import crypto from 'crypto'
import { readFileSync } from 'fs'

const MAX_REDIRECTS = 5

function download(url, dest, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url} to ${dest}`)
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`Invalid URL '${url}'`))
      return
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error(`Refusing non-https URL '${url}'`))
      return
    }
    let req
    try {
      req = https.get(parsed, (response) => {
        console.log(`Response status code: ${response.statusCode}`)
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume()
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects fetching '${url}'`))
            return
          }
          let next
          try {
            next = new URL(response.headers.location, parsed).toString()
          } catch {
            reject(new Error(`Bad redirect from '${url}'`))
            return
          }
          console.log(`Redirecting to ${next}`)
          download(next, dest, redirectsLeft - 1).then(resolve, reject)
          return
        } else if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`Failed to get '${url}' (${response.statusCode})`))
          return
        }
        const file = fs.createWriteStream(dest)
        const fail = (err) => {
          file.destroy()
          fs.unlink(dest, () => reject(err))
        }
        file.on('error', fail)
        response.on('error', fail)
        file.on('finish', () => file.close(() => resolve()))
        response.pipe(file)
      })
    } catch (err) {
      reject(err)
      return
    }
    req.on('error', (err) => fs.unlink(dest, () => reject(err)))
  })
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function assertSha256(filePath, expected) {
  const actual = sha256File(filePath)
  if (actual !== String(expected).toLowerCase()) {
    fs.rmSync(filePath, { force: true })
    throw new Error(
      `sha256 mismatch for ${filePath}: expected ${expected}, got ${actual}`
    )
  }
}

// Downloads url to dest unless a cached copy with the pinned hash is already
// there. A cached file with the wrong hash is deleted and fetched again.
// Returns true when a fresh copy was downloaded.
async function fetchPinned(url, dest, expected) {
  if (fs.existsSync(dest)) {
    if (sha256File(dest) === String(expected).toLowerCase()) return false
    console.log(`Cached ${dest} does not match its pinned sha256; refetching`)
    fs.rmSync(dest, { force: true })
  }
  await download(url, dest)
  assertSha256(dest, expected)
  return true
}

async function validateZipArchive(filePath, targetDir) {
  const archive = await unzipper.Open.file(filePath)
  for (const entry of archive.files) {
    assertSafeZipEntry(entry, targetDir)
  }
}

async function decompress(filePath, targetDir) {
  console.log(`Decompressing ${filePath} to ${targetDir}`)
  if (filePath.endsWith('.zip')) {
    await validateZipArchive(filePath, targetDir)
    await fs
      .createReadStream(filePath)
      .pipe(unzipper.Extract({ path: targetDir }))
      .promise()
  } else if (filePath.endsWith('.tar.gz')) {
    await tar.x({
      file: filePath,
      cwd: targetDir,
      preservePaths: false,
      filter: (entryPath, entry) => {
        assertSafeTarEntry(entryPath, entry, targetDir)
        return true
      },
    })
  } else {
    throw new Error(`Unsupported archive format: ${filePath}`)
  }
}

// sqlite-vec is pinned to a tag with a sha256 per platform (sqlite-vec-manifest.json).
// SQLVEC_URL / JAN_SQLITE_VEC_URL override the URL; SQLVEC_SHA256 must then
// supply the expected hash, since an override has no pinned entry.
function resolveSqliteVec(platform, arch) {
  const override = process.env.SQLVEC_URL || process.env.JAN_SQLITE_VEC_URL
  if (override) {
    const sha256 = process.env.SQLVEC_SHA256
    if (!sha256) throw new Error('SQLVEC_URL override requires SQLVEC_SHA256')
    return { url: override, sha256 }
  }
  const manifest = JSON.parse(
    fs.readFileSync(new URL('./sqlite-vec-manifest.json', import.meta.url), 'utf8')
  )
  const entry = manifest.assets[`${platform}-${arch}`]
  // No asset for this platform (e.g. windows-arm64): skip, linear fallback applies.
  if (!entry) return null
  return { url: `${manifest.baseUrl}/${entry.name}`, sha256: entry.sha256 }
}

function getPlatformArch() {
  const rustPlatform = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n')
    .find((line) => line.startsWith('host:'))
    .slice('host:'.length)
    .trim()
  const [arch, vendor, os, abi] = rustPlatform.split('-')
  // handle cases without abi
  const abiSuffix = abi ? `-${abi}` : ''

  let bunArch = arch
  let bunAbiSuffix = ''
  let uvVendor = vendor

  switch(arch) {
    case 'x86_64': bunArch = 'x64'; break
  }
  switch(os) {
    case 'linux':
      // uv linux alpine case:
      // rustPlatform: ${arch}-alpine-linux-musl
      // uvPlatform:  ${arch}-unknown-linux-musl
      uvVendor = 'unknown'

      // glibc : linux-${arch}
      // musl  : linux-${arch}-musl
      switch(abiSuffix) {
        case '-musl': bunAbiSuffix = '-musl'; break
      }
      break
    case 'windows': break
    case 'darwin':  break
    default: throw new Error(`Unsupported platform: ${os}`)
  }

  const bunPlatform = `${os}-${bunArch}${bunAbiSuffix}`
  const uvPlatform  = `${arch}-${uvVendor}-${os}${abiSuffix}`

  return { bunPlatform, uvPlatform, rustPlatform }
}

async function main() {
  if (process.env.SKIP_BINARIES) {
    console.log('Skipping binaries download.')
    process.exit(0)
  }
  console.log('Starting main function')
  const platform = os.platform()
  const { bunPlatform, uvPlatform, rustPlatform } = getPlatformArch()
  console.log(`bunPlatform : ${bunPlatform}`)
  console.log(`uvPlatform  : ${uvPlatform}`)
  console.log(`rustPlatform: ${rustPlatform}`)

  const binDir = 'src-tauri/resources/bin'
  const tempBinDir = 'scripts/dist'
  const bunPath = `${tempBinDir}/bun-${bunPlatform}.zip`
  let uvPath = `${tempBinDir}/uv-${uvPlatform}.tar.gz`
  if (platform === 'win32') {
    uvPath = `${tempBinDir}/uv-${uvPlatform}.zip`
  }
  mkdirSync(tempBinDir, { recursive: true })

  // bun and uv are pinned to a release with a sha256 per asset (sidecar-manifest.json).
  const sidecars = JSON.parse(
    fs.readFileSync(new URL('./sidecar-manifest.json', import.meta.url), 'utf8')
  )
  const bunAsset = `bun-${bunPlatform}.zip`
  const uvAsset = `uv-${uvPlatform}.${platform === 'win32' ? 'zip' : 'tar.gz'}`
  const bunSha = sidecars.bun.assets[bunAsset]
  const uvSha = sidecars.uv.assets[uvAsset]
  if (!bunSha) throw new Error(`No pinned bun asset for ${bunAsset}`)
  if (!uvSha) throw new Error(`No pinned uv asset for ${uvAsset}`)
  const bunUrl = `${sidecars.bun.baseUrl}/${bunAsset}`
  const uvUrl = `${sidecars.uv.baseUrl}/${uvAsset}`

  console.log(`Downloading Bun for ${bunPlatform}...`)
  const bunSaveDir = path.join(tempBinDir, `bun-${bunPlatform}.zip`)
  const bunExtractedDir = path.join(tempBinDir, `bun-${bunPlatform}`)
  const bunExtracted = path.join(bunExtractedDir, platform === 'win32' ? 'bun.exe' : 'bun')
  const bunFresh = await fetchPinned(bunUrl, bunSaveDir, bunSha)
  // A cached archive may never have been extracted (or only half of it).
  if (bunFresh || !fs.existsSync(bunExtracted)) {
    fs.rmSync(bunExtractedDir, { recursive: true, force: true })
    await decompress(bunPath, tempBinDir)
  }
  installSidecar({
    name: 'bun',
    extractedBinary: bunExtracted,
    binDir,
    platform,
    rustPlatform,
    uvPlatform,
  })
  console.log('Bun downloaded.')

  console.log(`Downloading UV for ${uvPlatform}...`)
  const uvExt = platform === 'win32' ? `zip` : `tar.gz`
  const uvSaveDir = path.join(tempBinDir, `uv-${uvPlatform}.${uvExt}`)
  // The windows zip is flat (uv.exe next to uvx.exe); the tarball nests uv
  // under uv-<platform>/.
  const uvExtractedDir = path.join(tempBinDir, `uv-${uvPlatform}`)
  const uvExtracted =
    platform === 'win32'
      ? path.join(tempBinDir, 'uv.exe')
      : path.join(uvExtractedDir, 'uv')
  const uvFresh = await fetchPinned(uvUrl, uvSaveDir, uvSha)
  if (uvFresh || !fs.existsSync(uvExtracted)) {
    if (platform !== 'win32') {
      fs.rmSync(uvExtractedDir, { recursive: true, force: true })
    }
    await decompress(uvPath, tempBinDir)
  }
  // Tauri resolves sidecars by the host triple (uv-aarch64-alpine-linux-musl
  // on Alpine), not by the name of the uv release asset.
  installSidecar({
    name: 'uv',
    extractedBinary: uvExtracted,
    binDir,
    platform,
    rustPlatform,
    uvPlatform,
  })
  console.log('UV downloaded.')

  // ----- sqlite-vec (optional, ANN acceleration) -----
  // The bundle configs list resources/bin/sqlite-vec.<ext>, so the file must
  // exist even when there is no library for this platform: an empty placeholder
  // fails to load and the app falls back to linear search.
  const sqlvecDir = 'src-tauri/resources/bin'
  const targetLibPath = path.join(sqlvecDir, sqliteVecLibName(os.platform()))
  try {
    if (fs.existsSync(targetLibPath) && fs.statSync(targetLibPath).size > 0) {
      console.log(`sqlite-vec already present at ${targetLibPath}`)
    } else {
      const pinned = resolveSqliteVec(os.platform(), os.arch())
      const sqlvecUrl = pinned?.url
      if (!sqlvecUrl) {
        console.log('No sqlite-vec build for this platform; skipping (linear fallback will be used).')
      } else if (!sqlvecUrl.endsWith('.tar.gz') && !sqlvecUrl.endsWith('.zip')) {
        console.log('Unknown archive type for sqlite-vec; expecting .zip or .tar.gz')
      } else {
        console.log(`Downloading sqlite-vec from ${sqlvecUrl}...`)
        const archivePath = path.join(
          tempBinDir,
          'sqlite-vec-download' + (sqlvecUrl.endsWith('.zip') ? '.zip' : '.tar.gz')
        )
        await download(sqlvecUrl, archivePath)
        assertSha256(archivePath, pinned.sha256)
        // Own folder, so the pick below cannot see bun/uv/llama files.
        const extractDir = path.join(tempBinDir, 'sqlite-vec')
        fs.rmSync(extractDir, { recursive: true, force: true })
        mkdirSync(extractDir, { recursive: true })
        await decompress(archivePath, extractDir)
        const files = []
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry)
            if (fs.statSync(full).isDirectory()) walk(full)
            else files.push(full)
          }
        }
        walk(extractDir)
        const libSrc = pickSqliteVecLibrary(files, os.platform())
        if (!libSrc) {
          console.log(`No vec0 library in the sqlite-vec archive (found: ${files.join(', ')}); skipping copy.`)
        } else {
          fs.copyFileSync(libSrc, targetLibPath)
          console.log(`sqlite-vec installed at ${targetLibPath} (from ${path.basename(libSrc)})`)
        }
      }
    }
  } catch (err) {
    console.log('sqlite-vec download step failed (non-fatal):', err)
  }
  if (!fs.existsSync(targetLibPath)) {
    mkdirSync(sqlvecDir, { recursive: true })
    fs.writeFileSync(targetLibPath, '')
    console.log(`Wrote empty ${targetLibPath} so the bundle config still resolves.`)
  }

  console.log('Downloads completed.')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
