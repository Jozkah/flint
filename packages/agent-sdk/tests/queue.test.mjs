// Unit tests for the SDK's event queue, per-tag listeners and channel errors.
// No runtime binary is needed: turns and sessions are driven directly.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JanRuntime, JanRuntimeError, JanSession, JanTurn } from '../src/index.js'

const timeout = (ms, what) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms).unref())
const within = (promise, what) => Promise.race([promise, timeout(2000, what)])
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('two concurrent next() calls each settle with their own event', async () => {
  const turn = new JanTurn({ maxBufferedEvents: 3 }, 't1')
  const it = turn[Symbol.asyncIterator]()
  const a = it.next()
  const b = it.next()
  turn._push('e1')
  turn._push('e2')
  assert.deepEqual(await within(a, 'a'), { value: 'e1', done: false })
  assert.deepEqual(await within(b, 'b'), { value: 'e2', done: false })
})

test('two for-await loops on one turn both finish', async () => {
  const turn = new JanTurn({ maxBufferedEvents: 3 }, 't1')
  const seen = []
  const loop = async () => {
    for await (const event of turn) seen.push(event)
  }
  const both = Promise.all([loop(), loop()])
  await tick()
  turn._push(1)
  turn._push(2)
  turn._push(3)
  turn._finish({ stopReason: 'end_turn' })
  await within(both, 'loops')
  assert.equal(seen.length, 3)
})

test('a draining reader never drops', async () => {
  const turn = new JanTurn({ maxBufferedEvents: 100 }, 't1')
  let count = 0
  const reader = (async () => {
    for await (const _ of turn) count += 1
  })()
  for (let burst = 0; burst < 100; burst += 1) {
    for (let i = 0; i < 100; i += 1) turn._push(i)
    await tick()
  }
  turn._finish({ stopReason: 'end_turn' })
  await within(reader, 'reader')
  assert.equal(turn.dropped, 0)
  assert.equal(count, 10000)
})

test('an undrained turn keeps at most the cap and counts drops', async () => {
  const turn = new JanTurn({ maxBufferedEvents: 3 }, 't1')
  for (let i = 1; i <= 8; i += 1) turn._push(i)
  assert.equal(turn.dropped, 5)
  const first = await turn[Symbol.asyncIterator]().next()
  assert.equal(first.value, 6)
})

test('fail() rejects a parked for-await', async () => {
  const turn = new JanTurn({ maxBufferedEvents: 3 }, 't1')
  const error = new JanRuntimeError('x')
  const loop = (async () => {
    for await (const _ of turn) {
      // no events expected
    }
  })()
  await tick()
  turn._fail(error)
  await assert.rejects(within(loop, 'loop'), (e) => e === error)
  await assert.rejects(turn.result(), (e) => e === error)
})

test('fail() with items buffered delivers them then throws', async () => {
  const turn = new JanTurn({ maxBufferedEvents: 3 }, 't1')
  const error = new JanRuntimeError('x')
  turn._push('a')
  turn._push('b')
  turn._fail(error)
  const seen = []
  await assert.rejects(
    (async () => {
      for await (const event of turn) seen.push(event)
    })(),
    (e) => e === error,
  )
  assert.deepEqual(seen, ['a', 'b'])
  await assert.rejects(turn.result(), (e) => e === error)
})

const makeSession = (callListener = (listener, event) => listener(event)) => {
  const runtime = { maxBufferedEvents: 100, _callListener: callListener }
  return new JanSession(runtime, { id: 's1', model: null, tools: [], toolSpecs: [] })
}

test("on('permission_request') fires for that tag only", () => {
  const session = makeSession()
  const got = []
  session.on('permission_request', (event) => got.push(event))
  session._deliver('permission_request', { turnId: 't1', event: { n: 1 } })
  session._deliver('token', { turnId: 't1', event: { n: 2 } })
  assert.deepEqual(got, [{ n: 1 }])
})

test("'*' and 'event' fire once per event even when a tag listener exists", () => {
  const session = makeSession()
  const star = []
  const evt = []
  const tag = []
  session.on('*', (e) => star.push(e))
  session.on('event', (e) => evt.push(e))
  session.on('token', (e) => tag.push(e))
  session._deliver('token', { turnId: 't1', event: { n: 1 } })
  assert.equal(star.length, 1)
  assert.equal(evt.length, 1)
  assert.equal(tag.length, 1)
})

test('unsubscribe stops tag listeners', () => {
  const session = makeSession()
  const got = []
  const off = session.on('token', (e) => got.push(e))
  session._deliver('token', { turnId: 't1', event: 1 })
  off()
  session._deliver('token', { turnId: 't1', event: 2 })
  assert.deepEqual(got, [1])
})

test('a tag listener that throws fails the runtime', () => {
  const failures = []
  const session = makeSession((listener, event) => {
    try {
      listener(event)
    } catch (error) {
      failures.push(error)
      session._fail(error)
    }
  })
  const boom = new Error('boom')
  const after = []
  session.on('token', () => {
    throw boom
  })
  session._deliver('token', { turnId: 't1', event: 1 })
  assert.deepEqual(failures, [boom])
  // The session is dead: nothing further is delivered to tag listeners.
  session.on('token', (e) => after.push(e))
  session._deliver('token', { turnId: 't1', event: 2 })
  assert.equal(after.length, 0)
})

test('a runtime with a dead stdin rejects requests and raises no uncaught exception', async () => {
  let uncaught = null
  const onUncaught = (error) => {
    uncaught = error
  }
  process.on('uncaughtException', onUncaught)
  try {
    const runtime = new JanRuntime({ bin: process.execPath, args: ['-e', 'process.exit(0)'] })
    await new Promise((resolve) => setTimeout(resolve, 500))
    await assert.rejects(runtime.request('x'), JanRuntimeError)
    await tick()
    assert.equal(uncaught, null)
  } finally {
    process.off('uncaughtException', onUncaught)
  }
})
