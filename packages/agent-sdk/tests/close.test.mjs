// A graceful close() keeps open turns registered until the runtime is gone, so
// the `interrupted` completion it writes while shutting down reaches the caller.
// A fake runtime (a node script speaking just enough of the protocol) stands in
// for `jan`, so this needs no binary.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JanRuntime, JanRuntimeError, PROTOCOL_VERSION } from '../src/index.js'

const FAKE = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
rl.on('line', (line) => {
  const f = JSON.parse(line)
  if (f.method === 'initialize') send({ id: f.id, result: { protocolVersion: ${JSON.stringify(PROTOCOL_VERSION)}, serverInfo: { name: 'fake', version: '0' } } })
  else if (f.method === 'session/start') send({ id: f.id, result: { sessionId: 's1', model: 'm', tools: [] } })
  else if (f.method === 'turn/start') send({ id: f.id, result: { turnId: 't1' } })
})
rl.on('close', () => {
  if (process.env.FAKE_COMPLETE === '1') {
    send({ method: 'turn/completed', params: { sessionId: 's1', turnId: 't1', stopReason: 'interrupted' } })
  }
  process.exit(0)
})
`

async function open(t, complete) {
  const dir = await mkdtemp(join(tmpdir(), 'jan-sdk-close-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const script = join(dir, 'fake.cjs')
  await writeFile(script, FAKE)
  const runtime = await JanRuntime.start({
    bin: process.execPath,
    args: [script],
    env: { FAKE_COMPLETE: complete ? '1' : '0' },
  })
  const session = await runtime.createSession({ cwd: dir, model: 'm', ephemeral: true })
  const turn = await session.prompt('hi')
  return { runtime, turn }
}

test('a graceful close delivers the interrupted completion the runtime writes', async (t) => {
  const { runtime, turn } = await open(t, true)
  const result = turn.result()
  await runtime.close()
  assert.equal((await result).stopReason, 'interrupted')
})

test('a graceful close still fails a turn the runtime left open', async (t) => {
  const { runtime, turn } = await open(t, false)
  const settled = assert.rejects(turn.result(), (error) => error instanceof JanRuntimeError)
  await runtime.close()
  await settled
})

test('a forced close fails open turns at once', async (t) => {
  const { runtime, turn } = await open(t, true)
  const settled = assert.rejects(turn.result(), /closed/)
  await runtime.close({ force: true })
  await settled
})
