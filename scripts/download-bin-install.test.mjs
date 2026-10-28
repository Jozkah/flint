import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installSidecar } from './download-bin-install.mjs'

function sandbox(fileName) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flint-sidecar-'))
  const extracted = path.join(root, 'extracted')
  mkdirSync(extracted)
  const extractedBinary = path.join(extracted, fileName)
  writeFileSync(extractedBinary, 'binary')
  return { root, extractedBinary, binDir: path.join(root, 'bin') }
}

const base = { name: 'bun', rustPlatform: 'x86_64-unknown-linux-gnu', uvPlatform: 'x86_64-pc-windows-msvc' }

test('throws when extracted binary missing', () => {
  const { root, binDir } = sandbox('bun')
  try {
    assert.throws(
      () => installSidecar({ ...base, extractedBinary: path.join(root, 'nope'), binDir, platform: 'linux' }),
      /not found/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chmods before copying and all suffixed copies are 0o755', { skip: process.platform === 'win32' }, () => {
  const { root, extractedBinary, binDir } = sandbox('bun')
  try {
    installSidecar({ ...base, extractedBinary, binDir, platform: 'linux' })
    for (const file of ['bun', 'bun-x86_64-unknown-linux-gnu']) {
      assert.equal(statSync(path.join(binDir, file)).mode & 0o777, 0o755, file)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('win32 copies bun.exe to bun-<uvPlatform>.exe', () => {
  const { root, extractedBinary, binDir } = sandbox('bun.exe')
  try {
    installSidecar({ ...base, extractedBinary, binDir, platform: 'win32' })
    assert.deepEqual(readdirSync(binDir).sort(), ['bun-x86_64-pc-windows-msvc.exe', 'bun.exe'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('darwin makes three copies', () => {
  const { root, extractedBinary, binDir } = sandbox('bun')
  try {
    installSidecar({ ...base, extractedBinary, binDir, platform: 'darwin' })
    assert.deepEqual(readdirSync(binDir).sort(), [
      'bun',
      'bun-aarch64-apple-darwin',
      'bun-universal-apple-darwin',
      'bun-x86_64-apple-darwin',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('linux makes one copy named with rustPlatform', () => {
  const { root, extractedBinary, binDir } = sandbox('bun')
  try {
    installSidecar({ ...base, extractedBinary, binDir, platform: 'linux' })
    assert.deepEqual(readdirSync(binDir).sort(), ['bun', 'bun-x86_64-unknown-linux-gnu'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
