import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  TARGETS,
  parseSums,
  renderHomebrew,
  renderNpmMeta,
  renderScoop,
  renderWinget,
  resolveAssets,
} from './render-package-manifests.mjs'

const tag = 'v1.2.3'
const repo = 'Jozkah/flint'
const hex = (n) => String(n).repeat(64).slice(0, 64)
const sums = parseSums(
  Object.values(TARGETS)
    .map(({ target, ext }, i) => `${hex(i + 1)}  flint-1.2.3-${target}.${ext}`)
    .join('\n'),
)
const ctx = { ...resolveAssets({ tag, repo, sums }), repo, tag }

test('parseSums reads sha256sum output, including the binary marker', () => {
  const m = parseSums(`${hex(7)} *a.zip\n${hex(8)}  b.tar.gz\nnot a line\n`)
  assert.equal(m.get('a.zip'), hex(7))
  assert.equal(m.get('b.tar.gz'), hex(8))
})

test('resolveAssets rejects a bad tag, bad repo and a missing checksum', () => {
  assert.throws(() => resolveAssets({ tag: 'nightly-1', repo, sums }), /tag must look like/)
  assert.throws(() => resolveAssets({ tag, repo: 'x; rm -rf /', sums }), /repo must be/)
  assert.throws(() => resolveAssets({ tag, repo, sums: new Map() }), /no checksum/)
})

test('homebrew formula carries every unix platform url and checksum', () => {
  const text = renderHomebrew(ctx)
  for (const key of ['linux_x64', 'linux_arm64', 'macos_arm64']) {
    assert.ok(text.includes(ctx.assets[key].url), key)
    assert.ok(text.includes(ctx.assets[key].sha256), key)
  }
  assert.match(text, /version "1\.2\.3"/)
})

test('scoop manifest points at the windows zip', () => {
  const json = JSON.parse(renderScoop(ctx))
  assert.equal(json.version, '1.2.3')
  assert.equal(json.architecture['64bit'].url, ctx.assets.windows_x64.url)
  assert.equal(json.architecture['64bit'].hash, ctx.assets.windows_x64.sha256)
})

test('winget renders the three manifests with an uppercase hash', () => {
  const files = renderWinget(ctx)
  assert.deepEqual(Object.keys(files).sort(), [
    'Jozkah.Flint.installer.yaml',
    'Jozkah.Flint.locale.en-US.yaml',
    'Jozkah.Flint.yaml',
  ])
  assert.ok(files['Jozkah.Flint.installer.yaml'].includes(ctx.assets.windows_x64.sha256.toUpperCase()))
})

test('npm meta records a checksum per target and keeps the rest of package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../packaging/npm/package.json', import.meta.url), 'utf8'))
  const out = renderNpmMeta(pkg, ctx)
  assert.equal(out.version, '1.2.3')
  assert.equal(out.name, pkg.name)
  assert.equal(Object.keys(out.flintBinary.assets).length, Object.keys(TARGETS).length)
  assert.equal(out.flintBinary.tag, tag)
})

test('npm platform table matches the release targets', async () => {
  const mod = await import('../packaging/npm/lib/platform.js')
  const npmTargets = mod.default?.TARGETS ?? mod.TARGETS
  const released = new Set(Object.values(TARGETS).map((t) => t.target))
  assert.deepEqual(new Set(Object.values(npmTargets).map((t) => t.target)), released)
})
