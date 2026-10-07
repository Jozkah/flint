// scripts/download.js
import https from 'https'
import fs, { copyFile, mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import unzipper from 'unzipper'
import tar from 'tar'
import { copySync } from 'cpx'
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
  try {
    mkdirSync('scripts/dist')
  } catch (err) {
    // Expect EEXIST error if the directory already exists
  }

  // Adjust these URLs based on latest releases
  const bunUrl = `https://github.com/oven-sh/bun/releases/latest/download/bun-${bunPlatform}.zip`

  let uvUrl = `https://github.com/astral-sh/uv/releases/latest/download/uv-${uvPlatform}.tar.gz`
  if (platform === 'win32') {
    uvUrl = `https://github.com/astral-sh/uv/releases/latest/download/uv-${uvPlatform}.zip`
  }

  console.log(`Downloading Bun for ${bunPlatform}...`)
  const bunSaveDir = path.join(tempBinDir, `bun-${bunPlatform}.zip`)
  if (!fs.existsSync(bunSaveDir)) {
    await download(bunUrl, bunSaveDir)
    await decompress(bunPath, tempBinDir)
  }
  try {
    copySync(
      path.join(tempBinDir, `bun-${bunPlatform}`, 'bun'),
      path.join(binDir)
    )
    // Windows has no execute bit, and the binary there is bun.exe.
    if (platform !== 'win32')
      fs.chmod(path.join(binDir, 'bun'), 0o755, (err) => {
      if (err) {
        console.log('Add execution permission failed!', err)
      }
    })
    if (platform === 'darwin') {
      copyFile(
        path.join(binDir, 'bun'),
        path.join(binDir, 'bun-x86_64-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
      copyFile(
        path.join(binDir, 'bun'),
        path.join(binDir, 'bun-aarch64-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
      copyFile(
        path.join(binDir, 'bun'),
        path.join(binDir, 'bun-universal-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    } else if (platform === 'linux') {
      copyFile(
        path.join(binDir, 'bun'),
        path.join(binDir, `bun-${rustPlatform}`),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    }
  } catch (err) {
    // Expect EEXIST error
  }
  try {
    copySync(
      path.join(tempBinDir, `bun-${bunPlatform}`, 'bun.exe'),
      path.join(binDir)
    )
    if (platform === 'win32') {
      copyFile(
        path.join(binDir, 'bun.exe'),
        // uvPlatform, not bunPlatform: tauri resolves an externalBin by rust
        // target triple, which is the spelling uv happens to use and bun does
        // not (bun ships windows-aarch64, tauri wants aarch64-pc-windows-msvc).
        path.join(binDir, `bun-${uvPlatform}.exe`),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    }
  } catch (err) {
    // Expect EEXIST error
  }
  console.log('Bun downloaded.')

  console.log(`Downloading UV for ${uvPlatform}...`)
  const uvExt = platform === 'win32' ? `zip` : `tar.gz`
  const uvSaveDir = path.join(tempBinDir, `uv-${uvPlatform}.${uvExt}`)
  if (!fs.existsSync(uvSaveDir)) {
    await download(uvUrl, uvSaveDir)
    await decompress(uvPath, tempBinDir)
  }
  try {
    copySync(path.join(tempBinDir, `uv-${uvPlatform}`, 'uv'), path.join(binDir))
    // Windows has no execute bit, and the binary there is uv.exe.
    if (platform !== 'win32')
      fs.chmod(path.join(binDir, 'uv'), 0o755, (err) => {
      if (err) {
        console.log('Add execution permission failed!', err)
      }
    })
    if (platform === 'darwin') {
      copyFile(
        path.join(binDir, 'uv'),
        path.join(binDir, 'uv-x86_64-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
      copyFile(
        path.join(binDir, 'uv'),
        path.join(binDir, 'uv-aarch64-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
      copyFile(
        path.join(binDir, 'uv'),
        path.join(binDir, 'uv-universal-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    } else if (platform === 'linux') {
      copyFile(
        path.join(binDir, 'uv'),
        // Tauri resolves sidecars by the host triple (uv-aarch64-alpine-linux-musl
        // on Alpine), not by the name of the uv release asset.
        path.join(binDir, `uv-${rustPlatform}`),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    }
  } catch (err) {
    // Expect EEXIST error
  }
  try {
    copySync(path.join(tempBinDir, 'uv.exe'), path.join(binDir))
    if (platform === 'win32') {
      copyFile(
        path.join(binDir, 'uv.exe'),
        path.join(binDir, `uv-${uvPlatform}.exe`),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    }
  } catch (err) {
    // Expect EEXIST error
  }
  console.log('UV downloaded.')

  // ----- sqlite-vec (optional, ANN acceleration) -----
  try {
    const binDir = 'src-tauri/resources/bin'
    const platform = os.platform()
    const ext = platform === 'darwin' ? 'dylib' : platform === 'win32' ? 'dll' : 'so'
    const targetLibPath = path.join(binDir, `sqlite-vec.${ext}`)

    if (fs.existsSync(targetLibPath)) {
      console.log(`sqlite-vec already present at ${targetLibPath}`)
    } else {
      const pinned = resolveSqliteVec(platform, os.arch())
      const sqlvecUrl = pinned?.url
      if (!sqlvecUrl) {
        console.log('Could not determine sqlite-vec download URL; skipping (linear fallback will be used).')
      } else {
        console.log(`Downloading sqlite-vec from ${sqlvecUrl}...`)
        const sqlvecArchive = path.join(tempBinDir, `sqlite-vec-download`)
        const guessedExt = sqlvecUrl.endsWith('.zip') ? '.zip' : sqlvecUrl.endsWith('.tar.gz') ? '.tar.gz' : ''
        const archivePath = sqlvecArchive + guessedExt
        await download(sqlvecUrl, archivePath)
        assertSha256(archivePath, pinned.sha256)
        if (!guessedExt) {
          console.log('Unknown archive type for sqlite-vec; expecting .zip or .tar.gz')
        } else {
          await decompress(archivePath, tempBinDir)
          // Try to find a shared library in the extracted files
          const candidates = []
          function walk(dir) {
            for (const entry of fs.readdirSync(dir)) {
              const full = path.join(dir, entry)
              const stat = fs.statSync(full)
              if (stat.isDirectory()) walk(full)
              else if (full.endsWith(`.${ext}`)) candidates.push(full)
            }
          }
          walk(tempBinDir)
          if (candidates.length === 0) {
            console.log('No sqlite-vec shared library found in archive; skipping copy.')
          } else {
            // Pick the first match and copy/rename to sqlite-vec.<ext>
            const libSrc = candidates[0]
            // Ensure we copy the FILE, not a directory (fs-extra copySync can copy dirs)
            if (fs.statSync(libSrc).isFile()) {
              fs.copyFileSync(libSrc, targetLibPath)
              console.log(`sqlite-vec installed at ${targetLibPath}`)
            } else {
              console.log(`Found non-file at ${libSrc}; skipping.`)
            }
          }
        }
      }
    }
  } catch (err) {
    console.log('sqlite-vec download step failed (non-fatal):', err)
  }

  console.log('Downloads completed.')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
