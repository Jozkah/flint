// End-to-end: a memory saved in chat A reaches the request chat B sends, and a
// real server answers it. Contacts only the configured test endpoint.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.env.JAN_TEST_PROVIDER_BASE_URL ?? 'http://v100:8555/v1'
const key = process.env.JAN_TEST_PROVIDER_API_KEY ?? randomBytes(32).toString('hex')
const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 12)
const PROBE = process.env.MEMORY_PROBE
const root = mkdtempSync(join(tmpdir(), 'jan-mem-e2e-'))

const probe = (...args) =>
  JSON.parse(
    execFileSync(PROBE, args, {
      encoding: 'utf8',
      env: { ...process.env, JAN_TEST_DATA_ROOT: root },
    })
  )

const fail = (m) => {
  console.log('FAIL:', m)
  process.exitCode = 1
}
const ok = (m) => console.log('  ok  ', m)

console.log('endpoint        :', BASE)
console.log('key fingerprint :', fingerprint)
console.log('isolated root   :', root)

// A marker no model could have produced on its own.
const marker = `QUJ-${randomUUID().slice(0, 8).toUpperCase()}`

try {
  // -- chat A saves a user-scoped memory ----------------------------------
  const { id } = probe(
    'remember',
    'user',
    'thread-A',
    `The deploy verification marker for this workspace is ${marker}.`
  )
  console.log('saved memory id :', id)

  // -- chat B, a different thread, selects ---------------------------------
  const inB = probe('select', 'thread-B')
  if (!inB.ids.includes(id)) fail(`chat B did not select ${id}`)
  else ok(`chat B selected ${id}`)
  if (!inB.block.includes(marker)) fail('the marker is not in the block')
  else ok('the block carries the marker')

  // -- the exact serialized request ----------------------------------------
  const models = await fetch(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  }).then((r) => r.json())
  const model = models.data[0].id
  const body = {
    model,
    stream: true,
    max_tokens: 24,
    messages: [
      { role: 'system', content: `You are Jan.\n\n${inB.block}` },
      { role: 'user', content: 'Acknowledge with one word.' },
    ],
  }
  const serialized = JSON.stringify(body)
  if (!serialized.includes(id)) fail(`the request body omits ${id}`)
  else ok(`the request body carries the memory id ${id}`)
  if (!serialized.includes(marker)) fail('the request body omits the marker')
  else ok('the request body carries the marker')
  if (serialized.includes(key)) fail('THE API KEY IS IN THE REQUEST BODY')
  else ok('the api key is not in the body (it is in the Authorization header)')

  // -- a real streamed response --------------------------------------------
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: serialized,
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) fail(`chat completion returned ${res.status}`)
  let done = false
  let chunks = 0
  for await (const part of res.body) {
    for (const line of Buffer.from(part).toString('utf8').split('\n')) {
      if (!line.startsWith('data:')) continue
      const p = line.slice(5).trim()
      if (p === '[DONE]') done = true
      else if (p) chunks += 1
    }
  }
  if (!done || chunks === 0) fail(`stream did not complete (chunks=${chunks})`)
  else ok(`real streamed response completed (${chunks} chunks)`)

  // -- the key must not be anywhere on disk --------------------------------
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (readFileSync(p, 'utf8').includes(key)) fail(`key found in ${name}`)
    }
  }
  walk(root)
  ok('the api key is absent from every persisted file')

  // -- forget, and chat C must not carry it --------------------------------
  const gone = probe('forget', 'user', id)
  if (!gone.forgotten) fail('forget reported nothing removed')
  const inC = probe('select', 'thread-C')
  if (inC.ids.includes(id)) fail(`chat C still carries ${id}`)
  else ok(`chat C no longer carries ${id}`)
  if (inC.block.includes(marker)) fail('chat C still carries the marker')
  else ok('chat C no longer carries the marker')

  // -- a temporary chat reads nothing --------------------------------------
  probe('remember', 'user', 'thread-A', `Second marker ${marker}-B.`)
  const temp = probe('select', 'thread-T', 'temporary')
  if (temp.ids.length !== 0) fail('a temporary chat selected memories')
  else ok('a temporary chat selected nothing')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(process.exitCode ? 'RESULT: FAILED' : 'RESULT: PASSED')
