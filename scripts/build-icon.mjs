/**
 * Generate the platform icon set from `src-tauri/icons/icon.png` without
 * changing that file.
 *
 * `tauri icon` writes its output next to the source and includes an
 * `icon.png` of its own, so running it on the tracked source re-encoded the
 * file in place on every dev or build run (#230). That dirtied the tree and
 * broke the Flint branding test, which hashes the source as the canonical
 * artwork. The source bytes are read first and written back afterwards,
 * whether the CLI succeeds or not.
 *
 * The source stays at `src-tauri/icons/icon.png` because the release
 * workflows copy the channel icon (beta, nightly) there before building.
 *
 * Usage: `node scripts/build-icon.mjs` (wired up as `yarn build:icon`).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const ICON_SOURCE = 'src-tauri/icons/icon.png'

/** Run `tauri icon` through the package manager's bin path. */
function runTauriIcon(source) {
  const result = spawnSync('tauri', ['icon', source], {
    stdio: 'inherit',
    shell: true,
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

/**
 * Generate the icon set from `source`, then restore the source's original
 * bytes if the generator changed them. Returns the generator's exit status.
 */
export function buildIcon({
  source = ICON_SOURCE,
  run = runTauriIcon,
} = {}) {
  const original = readFileSync(source)
  try {
    return run(source)
  } finally {
    const after = readFileSync(source)
    if (!after.equals(original)) writeFileSync(source, original)
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  process.exit(buildIcon())
}
