#!/usr/bin/env node
// Builds a signed engine add-on pack (src-tauri/plugins/tauri-plugin-llamacpp/
// src/engine/addon.rs reads it) from a staged engine directory:
//
//   <stem>.zip        manifest.json + manifest.json.sig + the module and runtime
//   <stem>.json       the same manifest plus the zip's own size and SHA-256
//   <stem>.json.sig   Ed25519 signature of <stem>.json
//   SHA256SUMS-<stem>.txt
//
// <stem> = flint-engine-<kind>-<tag>-<platform>. The signing key is the 32-byte
// Ed25519 seed, base64, in FLINT_ADDON_SIGNING_KEY (scripts/engine-addon/
// keygen.mjs makes one). Without it nothing is written: an unsigned pack is
// one the app refuses anyway.
//
// usage: node scripts/engine-addon/pack.mjs --bin-dir src-tauri/resources/bin \
//          --kind cuda13 --tag v0.9.0 --platform win-x64 --out dist-addon \
//          [--cuda-toolkit 13.0] [--min-driver 580] [--min-compute 75]
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')

function args() {
  const out = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected ${argv[i]}`)
    out[argv[i].slice(2)] = argv[i + 1]
  }
  return out
}

const a = args()
for (const k of ['bin-dir', 'kind', 'tag', 'platform', 'out']) {
  if (!a[k]) throw new Error(`--${k} is required`)
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(a.tag)) throw new Error(`bad tag ${a.tag}`)
if (!/^(cuda\d+|hip\d+)$/.test(a.kind)) throw new Error(`bad kind ${a.kind}`)

// The engine pin the pack is compiled against, read from the same constants
// the app compiles in, so a pack can only claim the ABI of this checkout.
const buildRs = fs.readFileSync(
  path.join(repo, 'src-tauri/plugins/tauri-plugin-llamacpp/build.rs'),
  'utf8'
)
const pin = (name) => {
  const m = new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(buildRs)
  if (!m) throw new Error(`no ${name} in build.rs`)
  return m[1]
}

const seedB64 = process.env.FLINT_ADDON_SIGNING_KEY ?? ''
const seed = Buffer.from(seedB64.trim(), 'base64')
if (seed.length !== 32) {
  console.error('FLINT_ADDON_SIGNING_KEY is not set to a 32-byte base64 Ed25519 seed; not building a pack')
  process.exit(2)
}
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' })
const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
const signB64 = (bytes) => sign(null, bytes, key).toString('base64')

const win = a.platform.startsWith('win')
const backend = a.kind.replace(/\d+$/, '')
const patterns = {
  cuda: win
    ? [/^ggml-cuda\.dll$/, /^cudart64_\d+\.dll$/, /^cublas64_\d+\.dll$/, /^cublasLt64_\d+\.dll$/, /^CUDA-EULA\.txt$/]
    : [/^libggml-cuda\.so$/, /^libcudart\.so\.\d+$/, /^libcublas\.so\.\d+$/, /^libcublasLt\.so\.\d+$/, /^CUDA-EULA\.txt$/],
}[backend]
if (!patterns) throw new Error(`no file list for backend ${backend}`)

const binDir = path.resolve(a['bin-dir'])
const names = fs.readdirSync(binDir).filter((n) => patterns.some((p) => p.test(n))).sort()
for (const p of patterns) {
  if (!names.some((n) => p.test(n))) throw new Error(`${binDir} has nothing matching ${p}`)
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const files = names.map((name) => {
  const file = path.join(binDir, name)
  return { name, size: fs.statSync(file).size, sha256: sha256(file) }
})

const manifest = {
  schema: 1,
  kind: a.kind,
  backend,
  release_tag: a.tag,
  platform: a.platform,
  engine_tag: pin('LLAMA_CPP_TAG'),
  engine_commit: pin('LLAMA_CPP_COMMIT'),
  cuda_toolkit: a['cuda-toolkit'] ?? null,
  min_driver: Number(a['min-driver'] ?? 580),
  min_compute: Number(a['min-compute'] ?? 75),
  files,
}

const stem = `flint-engine-${a.kind}-${a.tag}-${a.platform}`
const out = path.resolve(a.out)
const stage = path.join(out, `${stem}.stage`)
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
const inner = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
fs.writeFileSync(path.join(stage, 'manifest.json'), inner)
fs.writeFileSync(path.join(stage, 'manifest.json.sig'), signB64(inner) + '\n')

const zip = path.join(out, `${stem}.zip`)
fs.rmSync(zip, { force: true })
const python = ['python3', 'python'].find((p) => {
  try {
    execFileSync(p, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})
if (!python) throw new Error('python is needed to write the zip')
execFileSync(
  python,
  [
    '-I',
    path.join(here, 'zip.py'),
    zip,
    path.join(stage, 'manifest.json'),
    path.join(stage, 'manifest.json.sig'),
    ...names.map((n) => path.join(binDir, n)),
  ],
  { stdio: 'inherit' }
)
fs.rmSync(stage, { recursive: true, force: true })

const outer = Buffer.from(
  JSON.stringify(
    { ...manifest, archive: { name: path.basename(zip), size: fs.statSync(zip).size, sha256: sha256(zip) } },
    null,
    2
  ) + '\n'
)
fs.writeFileSync(path.join(out, `${stem}.json`), outer)
fs.writeFileSync(path.join(out, `${stem}.json.sig`), signB64(outer) + '\n')

const sums = [`${stem}.zip`, `${stem}.json`, `${stem}.json.sig`]
  .map((n) => `${sha256(path.join(out, n))}  ${n}`)
  .join('\n')
fs.writeFileSync(path.join(out, `SHA256SUMS-${stem}.txt`), sums + '\n')
console.log(sums)
console.log(`public key: ${pub.toString('base64')}`)
console.log(`${files.length} files, ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB zipped`)
