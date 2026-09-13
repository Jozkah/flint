/** AH-073: a count belongs to one dispatch, or it is not recorded at all. */
import { beforeEach, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => undefined)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [])),
}))

import { lookupPayloadUsage, recordPayloadUsage } from '../payloadUsage'

const snapshot = {
  id: 'snap-1',
  hash: 'fnv1a64:abc',
  redactions: 2,
  invocation: 'inv-1',
}

const recorded = () =>
  invoke.mock.calls
    .filter((c) => c[0] === 'payload_usage_record')
    .map((c) => (c[1] as { usage: Record<string, unknown> }).usage)

beforeEach(() => {
  invoke.mockClear()
  invoke.mockImplementation(async () => undefined)
})

it("binds the provider's count to the payload it counted", async () => {
  await recordPayloadUsage({
    session: 's1',
    run: 'r1',
    snapshot,
    model: 'smoke-model',
    usage: { prompt_tokens: 3367, completion_tokens: 120, total_tokens: 3487 },
  })
  expect(recorded()[0]).toMatchObject({
    invocation: 'inv-1',
    snapshot: 'snap-1',
    snapshot_hash: 'fnv1a64:abc',
    prompt_tokens: 3367,
    total_tokens: 3487,
    source: 'provider',
  })
})

it('records nothing rather than a count nobody can place', async () => {
  await recordPayloadUsage({
    session: 's1',
    run: 'r1',
    snapshot: { id: 'snap-2', hash: 'h', redactions: 0 },
    usage: { prompt_tokens: 10 },
  })
  await recordPayloadUsage({
    session: 's1',
    run: 'r1',
    snapshot: null,
    usage: { prompt_tokens: 10 },
  })
  expect(recorded()).toHaveLength(0)
})

it('drops a nonsense figure instead of storing it', async () => {
  await recordPayloadUsage({
    session: 's1',
    run: 'r1',
    snapshot,
    usage: { prompt_tokens: -1, completion_tokens: Number.NaN },
  })
  expect(recorded()[0]).toMatchObject({
    prompt_tokens: null,
    completion_tokens: null,
  })
})

it('never fails a run because its accounting could not be written', async () => {
  invoke.mockRejectedValue(new Error('no backend'))
  // Resolves, never rejects -- and says the record was not accepted.
  await expect(
    recordPayloadUsage({ session: 's1', run: 'r1', snapshot, usage: {} })
  ).resolves.toBe(false)
})

it('says when the backend accepted the record', async () => {
  invoke.mockResolvedValue(undefined)
  await expect(
    recordPayloadUsage({ session: 's1', run: 'r1', snapshot, usage: {} })
  ).resolves.toBe(true)
})

it('refuses an unscoped lookup rather than reading everything', async () => {
  expect(await lookupPayloadUsage({})).toEqual([])
  expect(invoke).not.toHaveBeenCalledWith('payload_usage_lookup', expect.anything())
})
