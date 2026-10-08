// End-to-end check of `flint serve` against the built web bundle.
//
//   node scripts/headless-smoke.mjs <path-to-flint> <path-to-web-bundle>
//
// Starts the server on a free loopback port with an empty data folder, then
// exercises sign-in, the bearer token flow, shared state, document upload and
// parse, the provider stream against a local mock provider, and the MCP
// stdio gate. Exits non-zero on the first failed check.

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const [, , given, assets] = process.argv
const binary = given && process.platform === 'win32' && !given.endsWith('.exe') ? `${given}.exe` : given
if (!given || !assets) {
  console.error('usage: node scripts/headless-smoke.mjs <flint> <web-bundle>')
  process.exit(2)
}

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
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

// A stand-in for the engine's model-router HTTP surface.
const modelState = new Map([['m1', 'unloaded']])
const sseClients = new Set()
const engineMock = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {}
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && req.url === '/models/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write([': subscribed', '', ''].join('\n'))
      sseClients.add(res)
      res.on('close', () => sseClients.delete(res))
      return
    }
    if (req.method === 'GET' && req.url === '/models') {
      return send(200, { data: [...modelState].map(([id, value]) => ({ id, status: { value } })) })
    }
    if (req.method === 'POST' && req.url === '/models/load') {
      if (body.model === 'bad') return send(400, { error: { message: 'unable to load model' } })
      const progress = { event: 'status_change', model: body.model, data: { status: 'loading', progress: { value: 0.5, current: 'text_model', stages: ['text_model'] } } }
      for (const client of sseClients) client.write([`data: ${JSON.stringify(progress)}`, '', ''].join('\n'))
      // A real load takes a while; the progress feed is only read while it runs.
      return setTimeout(() => {
        modelState.set(body.model, 'loaded')
        send(200, { success: true })
      }, 300)
    }
    if (req.method === 'POST' && req.url === '/models/unload') {
      modelState.set(body.model, 'unloaded')
      return send(200, { success: true })
    }
    if (req.method === 'POST' && req.url === '/models/reload') {
      return send(200, { added: [], changed: ['m1'], removed: [], kept: [], models_max: 1 })
    }
    send(404, { error: { message: 'not found' } })
  })
})
await new Promise((resolve) => engineMock.listen(0, '127.0.0.1', resolve))
const enginePort = engineMock.address().port

const upstream = createServer((req, res) => {
  req.resume()
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: one\n\n')
  setTimeout(() => res.end('data: [DONE]\n\n'), 150)
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

const data = mkdtempSync(join(tmpdir(), 'flint-smoke-'))
// A stand-in for flint-llama-worker: prints the handshake, then waits for its
// stdin to close, which is how the real worker is told to stop.
const fakeWorker = join(data, process.platform === 'win32' ? 'fake-worker.cmd' : 'fake-worker.sh')
const handshake = `{"port":${enginePort},"pid":4242,"models":["m1"]}`
writeFileSync(
  fakeWorker,
  process.platform === 'win32'
    ? ['@echo off', `echo ${handshake}`, 'more >nul', ''].join('\r\n')
    : ['#!/bin/sh', `echo '${handshake}'`, 'cat >/dev/null', ''].join('\n')
)
chmodSync(fakeWorker, 0o755)
const port = await freePort()
const base = `http://127.0.0.1:${port}`
const server = spawn(
  binary,
  ['serve', '--listen', `127.0.0.1:${port}`, '--assets-dir', assets, '--data-dir', data, '--llama-worker', fakeWorker],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
let log = ''
server.stdout.on('data', (chunk) => (log += chunk))
server.stderr.on('data', (chunk) => (log += chunk))

const stop = () => {
  server.kill()
  upstream.close()
  engineMock.close()
  try {
    rmSync(data, { recursive: true, force: true })
  } catch {
    // The server may still hold a file for a moment; the OS temp cleaner owns it.
  }
}

try {
  for (let i = 0; i < 100 && !/administrator credential/.test(log); i++) await sleep(100)
  const credential = log.match(/[0-9a-f]{64}/)?.[0]
  check('server started and printed a credential', !!credential, log)

  const json = (path, init = {}) =>
    fetch(base + path, { redirect: 'manual', ...init })

  const form = (body) => json('/api/v1/session', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  const wrong = await form(`credential=${'0'.repeat(64)}`)
  check('a wrong credential from the form goes back to the sign-in page', wrong.status === 303 && wrong.headers.get('location') === '/login?error=invalid')
  const malformed = await form('credential=short')
  check('a malformed credential from the form goes back with a notice', malformed.status === 303 && malformed.headers.get('location') === '/login?error=format')
  const loginHtml = await (await json('/login?error=invalid')).text()
  check('the sign-in page explains a failed attempt', loginHtml.includes('role="alert"') && !loginHtml.includes('{{'))
  check('the sign-in page never echoes the request', !(await (await json('/login?error=%3Cscript%3E')).text()).includes('<script>'))
  check('unauthenticated page redirects to sign-in', (await json('/')).status === 303)
  check('health is open', (await json('/healthz')).status === 200)
  check(
    'wrong credential is refused',
    (await json('/api/v1/token', { method: 'POST', body: JSON.stringify({ credential: '0'.repeat(64) }) })).status === 401
  )

  // One client guessing wrongly is stopped; others are not, and neither is
  // the real credential from a different client.
  const asClient = (address) => ({ 'x-forwarded-for': address })
  for (let i = 0; i < 10; i++) await json('/api/v1/token', { method: 'POST', headers: asClient('203.0.113.7'), body: JSON.stringify({ credential: '1'.repeat(64) }) })
  const noisy = await json('/api/v1/token', { method: 'POST', headers: asClient('203.0.113.7'), body: JSON.stringify({ credential }) })
  check('a client that keeps guessing wrong is blocked, even with the right credential', noisy.status === 429)
  const bystander = await json('/api/v1/token', { method: 'POST', headers: asClient('203.0.113.8'), body: JSON.stringify({ credential }) })
  check('another client can still sign in', bystander.status === 200)
  const signIn = await json('/api/v1/token', { method: 'POST', body: JSON.stringify({ credential }) })
  const { token } = await signIn.json()
  check('token sign-in', signIn.status === 200 && token?.length === 64)
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  const cookie = await json('/api/v1/session', {
    method: 'POST',
    headers: { origin: base },
    body: `credential=${credential}`,
  })
  const session = (cookie.headers.get('set-cookie') ?? '').split(';')[0]
  check('cookie sign-in', cookie.status === 303 && session.startsWith('flint_session='))
  const nullOrigin = await json('/api/v1/session', { method: 'POST', headers: { origin: 'null' }, body: `credential=${credential}` })
  check('sign-in does not depend on the Origin header', nullOrigin.status === 303)
  check('other posts still need a matching origin', (await json('/api/v1/projects', { method: 'PUT', headers: { cookie: session, origin: 'null', 'content-type': 'application/json' }, body: '[]' })).status === 403)
  const page = await json('/', { headers: { cookie: session } })
  check('signed-in page and its boot scripts load', page.status === 200 && (await json('/boot-appearance.js', { headers: { cookie: session } })).status === 200)
  check('referrer policy lets a form post carry its origin', page.headers.get('referrer-policy') === 'same-origin')
  check('csp blocks inline script', /script-src 'self'/.test(page.headers.get('content-security-policy') ?? ''))
  check('bad bearer is not rescued by a cookie', (await json('/api/v1/projects', { headers: { authorization: `Bearer ${'0'.repeat(64)}`, cookie: session } })).status === 401)

  // Shared state
  await json('/api/v1/projects', { method: 'PUT', headers: auth, body: JSON.stringify([{ id: 'p1', name: 'One' }]) })
  check('projects round trip', (await (await json('/api/v1/projects', { headers: auth })).json())[0]?.name === 'One')
  const thread = await (await json('/api/v1/threads', { method: 'POST', headers: auth, body: JSON.stringify({ title: 'T' }) })).json()
  check('thread created', typeof thread.id === 'string')
  check('hardware info', (await json('/api/v1/hardware/info', { headers: auth })).status === 200)
  check('hardware usage', (await json('/api/v1/hardware/usage', { headers: auth })).status === 200)
  check('app info', (await (await json('/api/v1/app/info', { headers: auth })).json()).headless === true)

  // Uploads
  const stored = await (await json('/api/v1/uploads?name=..%2Fnotes.txt', { method: 'POST', headers: { authorization: auth.authorization }, body: 'hello upload' })).json()
  check('upload name is sanitised', stored.name === 'notes.txt')
  const parsed = await (await json('/api/v1/uploads/parse', { method: 'POST', headers: auth, body: JSON.stringify({ path: stored.path, type: 'txt' }) })).json()
  check('upload parses', parsed.text === 'hello upload')
  check('outside path refused', (await json('/api/v1/uploads/parse', { method: 'POST', headers: auth, body: JSON.stringify({ path: join(data, '..'), type: 'txt' }) })).status === 422)

  // Provider stream
  const stream = await json('/api/v1/provider/stream', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ url: `http://127.0.0.1:${upstreamPort}/v1/chat`, method: 'POST', body: '{}', streamId: 'smoke' }),
  })
  const lines = (await stream.text()).trim().split('\n').map((line) => JSON.parse(line))
  const text = lines.filter((l) => l.kind === 'data').map((l) => Buffer.from(l.b64, 'base64').toString()).join('')
  check('provider stream delivers head, data and end', lines[0].kind === 'head' && lines.at(-1).kind === 'end' && text.includes('[DONE]'))
  check('non-http provider url refused', (await json('/api/v1/provider/stream', { method: 'POST', headers: auth, body: JSON.stringify({ url: 'file:///etc/passwd' }) })).status === 400)

  // Keys
  await json('/api/v1/provider-keys/smoke-provider', { method: 'PUT', headers: auth, body: JSON.stringify({ keys: ['k-one'] }) })
  check('provider key stored', (await (await json('/api/v1/provider-keys/smoke-provider', { headers: auth })).json()).keys[0] === 'k-one')
  await json('/api/v1/provider-keys/smoke-provider', { method: 'DELETE', headers: auth })
  check('provider key deleted', (await (await json('/api/v1/provider-keys/smoke-provider', { headers: auth })).json()).keys.length === 0)

  // MCP gate: stdio is off without --allow-mcp-stdio
  const mcp = await json('/api/v1/mcp/servers/echo/activate', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ config: { command: 'node', args: ['-e', '0'], env: {} }, start: true }),
  })
  check('stdio MCP refused without the flag', mcp.status === 400 && /allow-mcp-stdio/.test(await mcp.text()))

  // Local engine supervision (fake worker)
  const preset = join(data, 'router.preset.ini')
  writeFileSync(preset, ['[*]', ''].join('\n'))
  const engine = (path, body) => json(`/api/v1/engine/${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body ?? {}) })
  check('engine preset outside the data folder refused', (await engine('start', { presetPath: join(tmpdir(), 'nope.ini') })).status === 400)
  check('engine env cannot redirect code', (await engine('start', { presetPath: preset, envs: { LD_PRELOAD: 'x' } })).status === 400)
  check('engine reports stopped before start', (await (await json('/api/v1/engine/info', { headers: auth })).json()) === null)
  const started = await (await engine('start', { presetPath: preset, modelsMax: 1 })).json()
  check('engine starts and reports port, key and models', started.port === enginePort && started.apiKey?.length === 64 && started.models[0] === 'm1')
  const again = await (await engine('start', { presetPath: preset })).json()
  check('a second start is idempotent', again.apiKey === started.apiKey)
  check('engine info reports it running', (await (await json('/api/v1/engine/info', { headers: auth })).json())?.pid === 4242)
  check('engine stops', (await engine('stop')).status === 204 && (await (await json('/api/v1/engine/info', { headers: auth })).json()) === null)
  check('engine version', typeof (await (await json('/api/v1/engine/version', { headers: auth })).json()).tag === 'string')

  // File and engine calls an extension makes (the Tauri bridge stand-in)
  const rpc = (command, body) => json(`/api/v1/rpc/${encodeURIComponent(command)}`, { method: 'POST', headers: auth, body: JSON.stringify(body ?? {}) })
  const note = join(data, 'models', 'm1', 'note.txt')
  check('rpc mkdir', (await rpc('mkdir', { args: [join(data, 'models', 'm1')] })).status === 200)
  check('rpc write and read', (await rpc('write_file_sync', { args: [note, 'hi'] })).status === 200 && (await (await rpc('read_file_sync', { args: [note] })).json()) === 'hi')
  check('rpc yaml round trip', (await rpc('write_yaml', { data: { name: 'm1' }, savePath: join(data, 'models', 'm1', 'model.yml') })).status === 200 && (await (await rpc('read_yaml', { path: join(data, 'models', 'm1', 'model.yml') })).json()).name === 'm1')
  check('rpc file:// paths resolve inside the data folder', (await (await rpc('exists_sync', { args: ['file://models/m1/note.txt'] })).json()) === true)
  check('rpc refuses a path outside the data folder', (await rpc('read_file_sync', { args: [join(data, '..', 'x.txt')] })).status === 400)
  await rpc('settings_set', { key: 'smoke_marker', value: '1' })
  check('rpc settings round trip', (await (await rpc('settings_get', { key: 'smoke_marker' })).json()) === '1')
  await rpc('settings_remove', { key: 'smoke_marker' })
  check('rpc settings removal', (await (await rpc('settings_get', { key: 'smoke_marker' })).json()) === null)
  check('rpc hardware for the extension', (await (await rpc('plugin:hardware|get_system_info')).json()).cpu !== undefined)
  for (const reserved of ['auth.json', 'server.json']) {
    check(`rpc will not touch the server's own ${reserved}`, (await rpc('read_file_sync', { args: [join(data, 'web-server', reserved)] })).status === 400 && (await rpc('write_file_sync', { args: [join(data, 'web-server', reserved), '{}'] })).status === 400)
  }
  check('rpc refuses an unknown command', (await rpc('factory_reset')).status === 404)
  const viaRpc = await (await rpc('plugin:llamacpp|start_engine', { presetPath: preset, modelsMax: 1, slotCacheMib: 0, envs: {} })).json()
  check('rpc starts the engine with the plugin argument names', viaRpc.port === enginePort && viaRpc.api_key?.length === 64)
  // Model sessions and GGUF inspection against the mock engine
  const sessionEngine = await (await rpc('plugin:llamacpp|start_engine', { presetPath: preset, modelsMax: 1, slotCacheMib: 0, envs: {} })).json()
  check('event stream needs a sign-in', (await json('/api/v1/events')).status === 303)
  const events = await fetch(`${base}/api/v1/events`, { headers: { authorization: auth.authorization } })
  check('event stream opens', events.status === 200 && (events.headers.get('content-type') ?? '').includes('text/event-stream'))
  const reader = events.body.getReader()
  const progressSeen = (async () => {
    const decoder = new TextDecoder()
    let seen = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return null
      seen += decoder.decode(value, { stream: true })
      const match = seen.match(/data: (\{"event":"llamacpp-model-load-progress".*\})/)
      if (match) return JSON.parse(match[1])
    }
  })()
  const loaded = await rpc('plugin:llamacpp|load_llama_model', { modelId: 'm1', isEmbedding: false })
  const loadedSession = await loaded.json()
  check('rpc loads a model and returns the session', loaded.status === 200 && loadedSession.model_id === 'm1' && loadedSession.port === enginePort && loadedSession.api_key === sessionEngine.api_key)
  const progressEvent = await Promise.race([progressSeen, sleep(5000).then(() => null)])
  check('model load progress reaches the event stream', progressEvent?.payload?.model === 'm1' && progressEvent.payload.value === 0.5, JSON.stringify(progressEvent))
  await reader.cancel()
  check('rpc lists loaded models', (await (await rpc('plugin:llamacpp|get_loaded_models')).json()).join() === 'm1')
  check('rpc finds a session by model', (await (await rpc('plugin:llamacpp|find_session_by_model', { modelId: 'm1' })).json())?.model_id === 'm1')
  check('rpc finds no session for an unloaded model', (await (await rpc('plugin:llamacpp|find_session_by_model', { modelId: 'other' })).json()) === null)
  const refused = await rpc('plugin:llamacpp|load_llama_model', { modelId: 'bad', isEmbedding: false })
  check('rpc passes a refused load on as the plugin error object', refused.status === 502 && typeof (await refused.json()).message === 'string')
  check('rpc unloads', (await (await rpc('plugin:llamacpp|unload_llama_model', { modelId: 'm1' })).json()).success === true && (await (await rpc('plugin:llamacpp|get_loaded_models')).json()).length === 0)
  check('rpc reloads the preset', (await (await rpc('plugin:llamacpp|reload_engine_models', { presetPath: preset, modelsMax: 1 })).json()).changed[0] === 'm1')
  check('rpc refuses a preset outside the data folder', (await rpc('plugin:llamacpp|reload_engine_models', { presetPath: join(tmpdir(), 'x.ini') })).status === 400)
  const gguf = join(tmpdir(), `flint-smoke-${process.pid}.gguf`)
  const str = (text) => { const b = Buffer.from(text); const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(b.length)); return Buffer.concat([n, b]) }
  const header = Buffer.alloc(24)
  header.write('GGUF'); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(0n, 8); header.writeBigUInt64LE(1n, 16)
  const kind = Buffer.alloc(4); kind.writeUInt32LE(8)
  writeFileSync(gguf, Buffer.concat([header, str('general.architecture'), kind, str('llama')]))
  const meta = await rpc('plugin:llamacpp|read_gguf_metadata', { path: gguf })
  check('rpc reads gguf metadata from a .gguf file outside the data folder', meta.status === 200 && JSON.stringify(await meta.json()).includes('llama'))
  check('rpc refuses a non-gguf path outside the data folder', (await rpc('plugin:llamacpp|read_gguf_metadata', { path: join(tmpdir(), 'x.txt') })).status === 400)
  check('rpc refuses a remote model path', (await rpc('plugin:llamacpp|read_gguf_metadata', { path: 'https://example.com/m.gguf' })).status === 400)
  const tensors = await rpc('plugin:llamacpp|find_gguf_tensors', { path: gguf, names: ['a'] })
  check('rpc reports which tensors a gguf holds', tensors.status === 200 && (await tensors.json()).length === 0)
  rmSync(gguf, { force: true })
  check('rpc derives an api key', typeof (await (await rpc('plugin:llamacpp|generate_api_key', { modelId: 'm1', apiSecret: 's' })).json()) === 'string')

  check('rpc stops the engine', (await rpc('plugin:llamacpp|stop_engine')).status === 200 && (await (await rpc('plugin:llamacpp|get_engine_info')).json()) === null)

  check('sign-out ends the token', (await json('/api/v1/session', { method: 'DELETE', headers: auth })).status === 204 && (await json('/api/v1/projects', { headers: auth })).status === 401)
  // `flint stop` ends a foreground server cleanly and clears its record.
  const stopped = spawnSync(binary, ['stop', '--data-dir', data], { encoding: 'utf8' })
  check('flint stop stops the server', /Flint server stopped/.test(stopped.stdout), stopped.stdout + stopped.stderr)
  await sleep(300)
  check('the server no longer answers after flint stop', await fetch(`${base}/healthz`).then(() => false, () => true))
  check('flint stop says so when nothing is running', /No Flint server is running/.test(spawnSync(binary, ['stop', '--data-dir', data], { encoding: 'utf8' }).stdout))
  console.log(`\n${checks.length} checks passed`)
} catch (error) {
  console.error(String(error))
  console.error('--- server log ---\n' + log)
  process.exitCode = 1
} finally {
  stop()
}
