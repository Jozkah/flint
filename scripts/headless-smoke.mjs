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
import { mkdtempSync, rmSync } from 'node:fs'
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
const port = await freePort()
const base = `http://127.0.0.1:${port}`
const server = spawn(
  binary,
  ['serve', '--listen', `127.0.0.1:${port}`, '--assets-dir', assets, '--data-dir', data],
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

  check('sign-out ends the token', (await json('/api/v1/session', { method: 'DELETE', headers: auth })).status === 204 && (await json('/api/v1/projects', { headers: auth })).status === 401)
  console.log(`\n${checks.length} checks passed`)
} catch (error) {
  console.error(String(error))
  console.error('--- server log ---\n' + log)
  process.exitCode = 1
} finally {
  stop()
}
