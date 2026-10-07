// End-to-end check of `flint serve` against the built web bundle.
//
//   node scripts/headless-smoke.mjs <path-to-flint> <path-to-web-bundle>
//
// Starts the server on a free loopback port with an empty data folder, then
// exercises sign-in, the bearer token flow, shared state, document upload and
// parse, the provider stream against a local mock provider, and the MCP
// stdio gate. Exits non-zero on the first failed check.

import { spawn } from 'node:child_process'
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
const handshake = '{"port":4242,"pid":4242,"models":["m1"]}'
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

  check('unauthenticated page redirects to sign-in', (await json('/')).status === 303)
  check('health is open', (await json('/healthz')).status === 200)
  check(
    'wrong credential is refused',
    (await json('/api/v1/token', { method: 'POST', body: JSON.stringify({ credential: '0'.repeat(64) }) })).status === 401
  )

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
  const page = await json('/', { headers: { cookie: session } })
  check('signed-in page and its boot scripts load', page.status === 200 && (await json('/boot-appearance.js', { headers: { cookie: session } })).status === 200)
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
  check('engine starts and reports port, key and models', started.port === 4242 && started.apiKey?.length === 64 && started.models[0] === 'm1')
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
  check('rpc refuses an unknown command', (await rpc('factory_reset')).status === 404)
  const viaRpc = await (await rpc('plugin:llamacpp|start_engine', { presetPath: preset, modelsMax: 1, slotCacheMib: 0, envs: {} })).json()
  check('rpc starts the engine with the plugin argument names', viaRpc.port === 4242 && viaRpc.api_key?.length === 64)
  check('rpc stops the engine', (await rpc('plugin:llamacpp|stop_engine')).status === 200 && (await (await rpc('plugin:llamacpp|get_engine_info')).json()) === null)

  check('sign-out ends the token', (await json('/api/v1/session', { method: 'DELETE', headers: auth })).status === 204 && (await json('/api/v1/projects', { headers: auth })).status === 401)
  console.log(`\n${checks.length} checks passed`)
} catch (error) {
  console.error(String(error))
  console.error('--- server log ---\n' + log)
  process.exitCode = 1
} finally {
  stop()
}
