#!/usr/bin/env node
/**
 * The pre-commit checks, as one cross-platform script.
 *
 * The hook that calls this used to *be* the checks: a single line of shell,
 * with no shebang and no executable bit. Git on Windows cannot start that --
 *
 *     error: cannot spawn .husky/pre-commit: Exec format error
 *
 * -- so every commit on Windows either failed or was made with `--no-verify`,
 * which is how a repository quietly loses its pre-commit gate. The hook is now
 * three lines of `sh` whose only job is to find Node; everything that decides
 * anything lives here, in a language that runs the same on every platform and
 * can be tested directly.
 *
 * Two checks, both cheap enough to run on every commit:
 *
 * 1. `git diff --check` -- whitespace errors and, more usefully, leftover
 *    conflict markers. Committing `<<<<<<< HEAD` is a bad afternoon.
 * 2. the workspace lint, which is what the original hook ran.
 *
 * Exit status is the first failure's, so the commit stops for the reason that
 * actually stopped it rather than for a summary of several.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

/** The repository root, derived from this file rather than from `cwd`. */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Run one command, inheriting stdio so the developer sees what failed.
 *
 * `shell` is off by default. A path containing a space is the normal case on
 * Windows (`C:\Users\Some Name\...`), and handing an unquoted command line to a
 * shell is how those turn into "file not found" for a directory that plainly
 * exists. The one place it is turned on is Yarn: since the CVE-2024-27980 fix
 * Node refuses to spawn a `.cmd` without a shell and returns `EINVAL`, and Yarn
 * on Windows is `yarn.cmd`. That is safe here and only here, because every
 * argument is a fixed literal with no spaces in it -- the one value that could
 * contain a space, the repository path, travels in `cwd` rather than on the
 * command line.
 */
function runCommand(command, args, cwd, useShell = false) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: useShell,
  })
  if (result.error) return { ok: false, status: 1, error: result.error }
  return { ok: result.status === 0, status: result.status ?? 1 }
}

/** `yarn` is `yarn.cmd` on Windows; see `runCommand` for why that needs a shell. */
export function yarnCommand(platform = process.platform) {
  return platform === 'win32' ? 'yarn.cmd' : 'yarn'
}

/**
 * The checks, in order.
 *
 * `run` and `exists` are injected so a test can drive this without a git
 * repository, a Node toolchain or a network.
 */
export function runChecks({
  root = repoRoot(),
  run = runCommand,
  exists = existsSync,
  platform = process.platform,
  log = console.error,
} = {}) {
  const diff = run('git', ['diff', '--cached', '--check'], root, false)
  if (!diff.ok) {
    log(
      'pre-commit: staged changes have whitespace errors or conflict markers.'
    )
    return diff.status || 1
  }

  // A fresh clone or a new worktree has no `node_modules`, and refusing to
  // commit until someone runs an install would be a worse gate than none: the
  // lint still runs in CI, and the check above still ran here.
  if (!exists(join(root, 'node_modules'))) {
    log('pre-commit: skipping lint -- run `yarn install` to enable it.')
    return 0
  }

  const lint = run(
    yarnCommand(platform),
    ['lint', '--fix', '--quiet'],
    root,
    platform === 'win32'
  )
  if (!lint.ok) {
    log('pre-commit: lint failed.')
    return lint.status || 1
  }
  return 0
}

// Only when run as a program, so importing this for a test does not exit the
// test runner.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  process.exit(runChecks())
}
