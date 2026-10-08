// Runs a real model through `flint serve` and the real engine worker.
//
//   node scripts/engine-smoke.mjs <flint> <web-bundle> <flint-llama-worker> <embedding.gguf>
//
// Needs a worker built with the `engine` feature and an embedding-model GGUF.
// Starts the server on a free loopback port with an empty data folder, then
// goes through the same calls the browser makes: start the engine, load the
// model, ask it for an embedding through the provider stream, unload, stop.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const [, , flint, assets, worker, model] = process.argv
if (!flint || !assets || !worker || !model) {
  console.error('usage: node scripts/engine-smoke.mjs <flint> <web-bundle> <worker> <embedding.gguf>')
  process.exit(2)
}

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) throw new Error(`check failed: ${name}`)
}

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

const data = mkdtempSync(join(tmpdir(), 'flint-engine-'))
const port = await freePort()
const base = `http://127.0.0.1:${port}`
const server = spawn(
  flint,
  ['serve', '--listen', `127.0.0.1:${port}`, '--assets-dir', assets, '--data-dir', data, '--llama-worker', worker],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
let log = ''
server.stdout.on('data', (c) => (log += c))
server.stderr.on('data', (c) => (log += c))

try {
  for (let i = 0; i < 100 && !/administrator credential/.test(log); i++) await sleep(100)
  const credential = log.match(/[0-9a-f]{64}/)?.[0]
  const signIn = await fetch(`${base}/api/v1/token`, { method: 'POST', body: JSON.stringify({ credential }) })
  const { token } = await signIn.json()
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const rpc = async (command, body = {}) => {
    const response = await fetch(`${base}/api/v1/rpc/${encodeURIComponent(command)}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }

  const gguf = await rpc('plugin:llamacpp|read_gguf_metadata', { path: model })
  check('real gguf metadata is read', gguf.status === 200, JSON.stringify(gguf.body))
  const support = await rpc('plugin:llamacpp|is_model_supported', { path: model, ctxSize: 2048 })
  check('model support is estimated against this machine', support.status === 200, JSON.stringify(support.body))
  console.log('     support:', JSON.stringify(support.body))

  const preset = join(data, 'router.preset.ini')
  const iniPath = (p) => p.replaceAll('\\', '/')
  writeFileSync(
    preset,
    ['[*]', 'load-on-startup = false', 'ctx-size = 2048', '', '[embed]', `model = ${iniPath(model)}`, 'embedding = true', ''].join('\n')
  )
  const started = await rpc('plugin:llamacpp|start_engine', { presetPath: preset, modelsMax: 1, slotCacheMib: 0, envs: {} })
  check('the real worker starts and reports its models', started.status === 200 && started.body.models.includes('embed'), JSON.stringify(started.body))

  const loaded = await rpc('plugin:llamacpp|load_llama_model', { modelId: 'embed', isEmbedding: true })
  check('the model loads', loaded.status === 200 && loaded.body.port === started.body.port, JSON.stringify(loaded.body))
  check('it is listed as loaded', (await rpc('plugin:llamacpp|get_loaded_models')).body.join() === 'embed')

  // Through the provider stream, as the browser does it.
  const stream = await fetch(`${base}/api/v1/provider/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: `http://127.0.0.1:${loaded.body.port}/v1/embeddings`,
      method: 'POST',
      headers: { authorization: `Bearer ${loaded.body.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'embed', input: ['hello world', 'a second sentence'] }),
      streamId: 'engine-smoke',
    }),
  })
  const lines = (await stream.text()).trim().split('\n').map((l) => JSON.parse(l))
  const head = lines.find((l) => l.kind === 'head')
  const text = lines.filter((l) => l.kind === 'data').map((l) => Buffer.from(l.b64, 'base64').toString()).join('')
  check('the embeddings request is answered', head?.status === 200, text.slice(0, 300))
  const answer = JSON.parse(text)
  const vectors = answer.data.map((d) => d.embedding)
  check('two vectors come back', vectors.length === 2 && vectors[0].length > 100, JSON.stringify(vectors.map((v) => v.length)))
  const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  check('the vectors are real numbers with magnitude', vectors.every((v) => v.every(Number.isFinite) && norm(v) > 0))
  console.log(`     dimension: ${vectors[0].length}`)

  check('it unloads', (await rpc('plugin:llamacpp|unload_llama_model', { modelId: 'embed' })).body.success === true)
  check('nothing is loaded afterwards', (await rpc('plugin:llamacpp|get_loaded_models')).body.length === 0)
  await rpc('plugin:llamacpp|stop_engine')
  check('the worker stops', (await rpc('plugin:llamacpp|get_engine_info')).body === null)
  console.log('\nengine smoke passed')
} catch (error) {
  console.error(String(error))
  console.error('--- server log ---\n' + log)
  process.exitCode = 1
} finally {
  server.kill()
  try {
    rmSync(data, { recursive: true, force: true })
  } catch {
    // The worker may hold a file a moment longer; the OS temp cleaner owns it.
  }
}
