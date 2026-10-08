// Many browsers and many chats at once against one `flint serve`.
//
//   node scripts/concurrency-smoke.mjs <flint> <web-bundle>
//
// Starts the server on an empty data folder and hammers the shared stores from
// several clients in parallel, then reads everything back and checks that
// nothing was lost, duplicated or corrupted.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const [, , flint, assets] = process.argv
if (!flint || !assets) {
  console.error('usage: node scripts/concurrency-smoke.mjs <flint> <web-bundle>')
  process.exit(2)
}

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`)
  if (!ok) failed++
}

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

const data = mkdtempSync(join(tmpdir(), 'flint-concurrency-'))
const port = await freePort()
const base = `http://127.0.0.1:${port}`
const server = spawn(flint, ['serve', '--listen', `127.0.0.1:${port}`, '--assets-dir', assets, '--data-dir', data], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
server.stdout.on('data', (c) => (log += c))
server.stderr.on('data', (c) => (log += c))

try {
  for (let i = 0; i < 100 && !/administrator credential/.test(log); i++) await sleep(100)
  const credential = log.match(/[0-9a-f]{64}/)[0]
  // Three separate sessions, as three browsers would hold.
  const clients = []
  for (let i = 0; i < 3; i++) {
    const { token } = await (await fetch(`${base}/api/v1/token`, { method: 'POST', body: JSON.stringify({ credential }) })).json()
    clients.push({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
  }
  const api = (client, method, path, body) =>
    fetch(base + path, { method, headers: clients[client % clients.length], body: body === undefined ? undefined : JSON.stringify(body) })

  // 1. Many chats at once, each with many messages, from different clients.
  const CHATS = 12
  const MESSAGES = 15
  const threads = await Promise.all(
    Array.from({ length: CHATS }, async (_, i) => (await api(i, 'POST', '/api/v1/threads', { title: `chat ${i}` })).json())
  )
  check('every chat is created with its own id', new Set(threads.map((t) => t.id)).size === CHATS)
  const posts = []
  for (const [t, thread] of threads.entries()) {
    for (let m = 0; m < MESSAGES; m++) {
      posts.push(api(t + m, 'POST', `/api/v1/threads/${thread.id}/messages`, { id: `m-${t}-${m}`, thread_id: thread.id, role: m % 2 ? 'assistant' : 'user', content: `c${t} m${m}` }))
    }
  }
  const statuses = (await Promise.all(posts)).map((r) => r.status)
  check('every message post succeeds', statuses.every((s) => s === 201), JSON.stringify([...new Set(statuses)]))
  let lost = 0
  let duplicated = 0
  for (const [t, thread] of threads.entries()) {
    const messages = await (await api(0, 'GET', `/api/v1/threads/${thread.id}/messages`)).json()
    const ids = messages.map((m) => m.id)
    lost += MESSAGES - new Set(ids).size
    duplicated += ids.length - new Set(ids).size
  }
  check('no message is lost across chats', lost === 0, `${lost} lost`)
  check('no message is duplicated', duplicated === 0, `${duplicated} duplicated`)

  // 2. The same message created twice at once (a retry) is stored once.
  const t0 = threads[0]
  const twin = { id: 'twin', thread_id: t0.id, role: 'user', content: 'same' }
  await Promise.all([api(0, 'POST', `/api/v1/threads/${t0.id}/messages`, twin), api(1, 'POST', `/api/v1/threads/${t0.id}/messages`, twin)])
  const afterTwin = await (await api(0, 'GET', `/api/v1/threads/${t0.id}/messages`)).json()
  check('a retried message is stored once', afterTwin.filter((m) => m.id === 'twin').length === 1)

  // 3. Edits to one chat from several clients never corrupt it, and none is lost
  //    when they touch different fields.
  const edits = Array.from({ length: 20 }, (_, i) =>
    api(i, 'PUT', `/api/v1/threads/${t0.id}`, { ...t0, title: `title ${i}`, ...(i === 7 ? { metadata: { order: 7 } } : {}) })
  )
  const editStatuses = (await Promise.all(edits)).map((r) => r.status)
  check('parallel edits to one chat all succeed', editStatuses.every((s) => s === 204), JSON.stringify([...new Set(editStatuses)]))
  const edited = await (await api(0, 'GET', `/api/v1/threads/${t0.id}`)).json()
  check('the chat is still valid after parallel edits', typeof edited.title === 'string' && edited.id === t0.id)

  // 4. Edit and delete messages while others are being added.
  const t1 = threads[1]
  const busy = [
    ...Array.from({ length: 10 }, (_, m) => api(m, 'POST', `/api/v1/threads/${t1.id}/messages`, { id: `extra-${m}`, thread_id: t1.id, role: 'user', content: `extra ${m}` })),
    api(0, 'PUT', `/api/v1/threads/${t1.id}/messages/m-1-0`, { id: 'm-1-0', thread_id: t1.id, role: 'user', content: 'edited' }),
    api(1, 'DELETE', `/api/v1/threads/${t1.id}/messages/m-1-1`),
  ]
  await Promise.all(busy)
  const t1Messages = await (await api(0, 'GET', `/api/v1/threads/${t1.id}/messages`)).json()
  check('adds, an edit and a delete on one chat all land', t1Messages.length === MESSAGES + 10 - 1 && t1Messages.find((m) => m.id === 'm-1-0')?.content === 'edited' && !t1Messages.some((m) => m.id === 'm-1-1'), `${t1Messages.length} messages`)

  // 5. Projects added from several browsers at once all survive.
  const names = Array.from({ length: 12 }, (_, i) => `project ${i}`)
  const added = await Promise.all(names.map((name, i) => api(i, 'POST', '/api/v1/projects', { id: `p${i}`, name, updated_at: i })))
  check('every project add succeeds', added.every((r) => r.status === 201))
  const projects = await (await api(0, 'GET', '/api/v1/projects')).json()
  check('projects added from several browsers all survive', projects.length === names.length, `${projects.length} of ${names.length}`)
  await Promise.all([
    api(0, 'PUT', '/api/v1/projects/p1', { name: 'renamed' }),
    api(1, 'DELETE', '/api/v1/projects/p2'),
    api(2, 'POST', '/api/v1/projects', { id: 'late', name: 'late' }),
  ])
  const changed = await (await api(0, 'GET', '/api/v1/projects')).json()
  check('a rename, a delete and an add at once all land', changed.find((p) => p.id === 'p1')?.name === 'renamed' && !changed.some((p) => p.id === 'p2') && changed.some((p) => p.id === 'late') && changed.length === names.length, JSON.stringify(changed.map((p) => p.id)))

  // 6. Settings and assistants from several clients.
  await Promise.all(Array.from({ length: 20 }, (_, i) => api(i, 'POST', '/api/v1/rpc/settings_set', { key: `k${i}`, value: `${i}` })))
  const settings = await Promise.all(Array.from({ length: 20 }, async (_, i) => (await (await api(0, 'POST', '/api/v1/rpc/settings_get', { key: `k${i}` })).json())))
  check('settings written in parallel are all kept', settings.every((v, i) => v === `${i}`))
  await Promise.all(Array.from({ length: 8 }, (_, i) => api(i, 'POST', '/api/v1/assistants', { id: `a${i}`, name: `assistant ${i}` })))
  check('assistants created in parallel are all kept', (await (await api(0, 'GET', '/api/v1/assistants')).json()).length === 8)

  // 7. The chat list shows every chat.
  const listed = await (await api(2, 'GET', '/api/v1/threads')).json()
  check('the chat list shows every chat', listed.length === CHATS, `${listed.length} of ${CHATS}`)
  console.log(failed ? `\n${failed} check(s) failed` : '\nconcurrency smoke passed')
} catch (error) {
  console.error(String(error))
  console.error('--- server log ---\n' + log)
  failed++
} finally {
  server.kill()
  try {
    rmSync(data, { recursive: true, force: true })
  } catch {
    // The OS temp cleaner owns whatever is still held.
  }
  process.exitCode = failed ? 1 : 0
}
