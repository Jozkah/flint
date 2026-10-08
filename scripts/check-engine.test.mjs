/**
 * Tests for the engine guard that stops a bare `yarn build` early.
 * Run with `node --test "scripts/*.test.mjs"`.
 *
 * The script finds the engine relative to its own location, so each test
 * copies it into a throwaway repo layout.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-engine.mjs')
const workerName =
  process.platform === 'win32' ? 'flint-llama-worker.exe' : 'flint-llama-worker'

const run = ({ withWorker, env = {} }) => {
  const root = mkdtempSync(join(tmpdir(), 'check-engine-'))
  try {
    mkdirSync(join(root, 'scripts'))
    copyFileSync(script, join(root, 'scripts', 'check-engine.mjs'))
    const bin = join(root, 'src-tauri', 'resources', 'bin')
    mkdirSync(bin, { recursive: true })
    if (withWorker) writeFileSync(join(bin, workerName), '')
    const childEnv = { ...process.env, ...env }
    if (!('FLINT_SKIP_ENGINE_CHECK' in env)) delete childEnv.FLINT_SKIP_ENGINE_CHECK
    return spawnSync(process.execPath, [join(root, 'scripts', 'check-engine.mjs')], {
      encoding: 'utf8',
      env: childEnv,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('check-engine', () => {
  it('passes when the engine worker is present', () => {
    assert.equal(run({ withWorker: true }).status, 0)
  })

  it('fails with a pointer to the installer script when it is missing', () => {
    const r = run({ withWorker: false })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /node scripts\/build-installer\.mjs/)
    assert.ok(r.stderr.includes(workerName))
  })

  it('is skipped by FLINT_SKIP_ENGINE_CHECK', () => {
    assert.equal(
      run({ withWorker: false, env: { FLINT_SKIP_ENGINE_CHECK: '1' } }).status,
      0
    )
  })
})
