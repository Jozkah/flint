/**
 * Run the platform variant of a package script: `node scripts/run-os.mjs
 * build:cli` runs `yarn run build:cli:win32` on Windows, `:darwin` on macOS
 * and `:linux` on Linux.
 *
 * Replaces the run-script-os package, which spawned with an argument list
 * and `shell: true` and so printed Node's DEP0190 deprecation on every build.
 *
 * Usage: `node scripts/run-os.mjs <script>`
 */
import { spawnSync } from 'node:child_process'

const script = process.argv[2]
if (!script || !/^[\w:.-]+$/.test(script)) {
  console.error('usage: node scripts/run-os.mjs <script>')
  process.exit(2)
}

const variant = `${script}:${process.platform}`
const result = spawnSync(`yarn run ${variant}`, { stdio: 'inherit', shell: true })
if (result.error) throw result.error
process.exit(result.status ?? 1)
