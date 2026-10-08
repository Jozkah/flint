#!/usr/bin/env node
/**
 * Stop an installer build early, in plain words, when Flint's llama.cpp engine
 * has not been built.
 *
 * Without it the build runs for several minutes and then ends in Cargo's
 * "resource path `resources\bin\flint-llama-worker.exe` doesn't exist", with no
 * installer and no hint about what to do. `yarn build` runs this first.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const worker = join(
  root,
  'src-tauri',
  'resources',
  'bin',
  process.platform === 'win32' ? 'flint-llama-worker.exe' : 'flint-llama-worker'
)

if (process.env.FLINT_SKIP_ENGINE_CHECK || existsSync(worker)) process.exit(0)

console.error(`
Flint's local-model engine has not been built yet, so there is nothing to put
in the installer. This file is missing:

  ${worker}

Do not run "yarn build" or "yarn tauri build" on its own. Run this one command
from the repository folder instead. It builds the engine and then the
installer, in any terminal:

  node scripts/build-installer.mjs

If you already ran "make build-engine" and still see this message, that step
failed. On Windows "make" only works in Git Bash, not PowerShell. The command
above avoids that.
`)
process.exit(1)
