import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

// Names tauri resolves an externalBin by, for one sidecar. darwin gets three
// (it builds per arch and universal), linux the host triple, windows the
// uv-spelled triple: tauri wants aarch64-pc-windows-msvc where bun ships
// windows-aarch64, and uvPlatform is the spelling that matches.
export function sidecarCopyNames({ name, platform, rustPlatform, uvPlatform }) {
  if (platform === 'darwin') {
    return [
      `${name}-x86_64-apple-darwin`,
      `${name}-aarch64-apple-darwin`,
      `${name}-universal-apple-darwin`,
    ]
  }
  if (platform === 'linux') return [`${name}-${rustPlatform}`]
  if (platform === 'win32') return [`${name}-${uvPlatform}.exe`]
  return []
}

// Copies an extracted sidecar binary into binDir under its plain name and
// every suffixed name tauri looks for. Synchronous and throwing on purpose: the
// old callback copies raced the chmod and swallowed ENOENT, so a missing
// binary looked like a successful download.
export function installSidecar({
  name,
  extractedBinary,
  binDir,
  platform,
  rustPlatform,
  uvPlatform,
}) {
  if (!existsSync(extractedBinary)) {
    throw new Error(`Expected ${name} binary not found at ${extractedBinary}`)
  }
  const exeName = platform === 'win32' ? `${name}.exe` : name
  mkdirSync(binDir, { recursive: true })
  const plain = path.join(binDir, exeName)
  try {
    copyFileSync(extractedBinary, plain)
  } catch (err) {
    // On Windows a running dev app holds bin/<name>.exe open.
    throw new Error(
      `Could not write ${plain}: ${err.message}. If the app is running, close it and retry.`
    )
  }
  // Windows has no execute bit.
  if (platform !== 'win32') chmodSync(plain, 0o755)
  for (const copyName of sidecarCopyNames({ name, platform, rustPlatform, uvPlatform })) {
    const target = path.join(binDir, copyName)
    copyFileSync(plain, target)
    if (platform !== 'win32') chmodSync(target, 0o755)
  }
}

// File name download-bin installs sqlite-vec under, in src-tauri/resources/bin.
// The tauri.<os>.conf.json bundles list exactly this name.
export function sqliteVecLibName(platform) {
  const ext = platform === 'darwin' ? 'dylib' : platform === 'win32' ? 'dll' : 'so'
  return `sqlite-vec.${ext}`
}

// The loadable library inside a sqlite-vec release archive. Only the exact
// `vec0.<ext>` counts: the old "first file ending in .<ext>" walk could copy
// any other library sitting in the extraction folder (H02-006).
export function pickSqliteVecLibrary(files, platform) {
  const want = `vec0.${sqliteVecLibName(platform).split('.').pop()}`
  const matches = files.filter((f) => f.split(/[\\/]/).pop() === want)
  if (matches.length > 1) {
    throw new Error(`sqlite-vec archive holds ${matches.length} copies of ${want}: ${matches.join(', ')}`)
  }
  return matches[0] ?? null
}
