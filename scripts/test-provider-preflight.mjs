// Bounded preflight against the configured test server. Contacts nothing else.
import { createHash, randomBytes } from 'node:crypto'
import dns from 'node:dns/promises'

const BASE = process.env.JAN_TEST_PROVIDER_BASE_URL ?? 'http://v100:8555/v1'

// Generated per run, never printed and never written anywhere.
const key = process.env.JAN_TEST_PROVIDER_API_KEY ?? randomBytes(32).toString('hex')
const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 12)

const classify = (a) => {
  if (a.startsWith('100.')) {
    const o = Number(a.split('.')[1])
    if (o >= 64 && o <= 127) return 'tailscale-cgnat'
  }
  if (/^(10\.|192\.168\.|169\.254\.)/.test(a)) return 'private'
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(a)) return 'private'
  if (a.startsWith('fd7a:115c:a1e0')) return 'tailscale-ula'
  if (a.startsWith('fe80:')) return 'link-local'
  if (/^f[cd]/i.test(a)) return 'private-v6'
  return 'public'
}

const host = new URL(BASE).hostname
const candidates = (await dns.lookup(host, { all: true })).map((c) => ({
  address: c.address,
  family: c.family,
  kind: classify(c.address),
}))
const isPrivate = (c) => c.kind !== 'public'
// A public candidate is never used when a private one exists.
const usable = candidates.some(isPrivate)
  ? candidates.filter(isPrivate)
  : candidates
const selected = usable[0]

console.log('configured url  :', BASE)
console.log('key fingerprint :', fingerprint)
console.log('candidates      :')
for (const c of candidates) {
  const mark = c === selected ? '->' : '  '
  console.log(`  ${mark} ${c.kind.padEnd(16)} v${c.family} ${c.address}`)
}
console.log(
  'suppressed public:',
  candidates.filter((c) => !isPrivate(c)).length
)

const auth = { Authorization: `Bearer ${key}` }
const withTimeout = (ms) => AbortSignal.timeout(ms)

// --- /models --------------------------------------------------------------
let models = []
try {
  const res = await fetch(`${BASE}/models`, {
    headers: auth,
    signal: withTimeout(15_000),
  })
  console.log('GET /models     :', res.status, res.statusText)
  if (res.ok) {
    const body = await res.json()
    models = (body.data ?? []).map((m) => m.id)
    console.log('model ids       :', models.join(', ') || '(none)')
  } else {
    console.log('body            :', (await res.text()).slice(0, 200))
  }
} catch (e) {
  console.log('GET /models     : FAILED', e.name, e.message)
  process.exit(2)
}

// --- one minimal streaming completion ------------------------------------
const model = models[0]
if (!model) {
  console.log('streaming       : skipped, the server advertises no model')
  process.exit(3)
}
try {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    }),
    signal: withTimeout(60_000),
  })
  console.log('POST /chat      :', res.status, res.statusText)
  if (!res.ok) {
    console.log('body            :', (await res.text()).slice(0, 300))
    process.exit(4)
  }
  let chunks = 0
  let done = false
  let text = ''
  for await (const part of res.body) {
    const s = Buffer.from(part).toString('utf8')
    for (const line of s.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        done = true
        continue
      }
      chunks += 1
      try {
        const j = JSON.parse(payload)
        text += j.choices?.[0]?.delta?.content ?? ''
      } catch {
        // A partial frame across a chunk boundary; the next read completes it.
      }
    }
  }
  console.log('stream chunks   :', chunks)
  console.log('stream completed:', done)
  console.log('reply text      :', JSON.stringify(text.slice(0, 60)))
} catch (e) {
  console.log('POST /chat      : FAILED', e.name, e.message)
  process.exit(5)
}
