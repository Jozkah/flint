import { describe, it, expect, vi, beforeEach } from 'vitest'

const { sandboxEnforces, buildCoworkTools } = vi.hoisted(() => ({
  sandboxEnforces: vi.fn(() => true),
  buildCoworkTools: vi.fn(),
}))
vi.mock('@/lib/agentTools', () => ({ sandboxEnforces }))
vi.mock('@/lib/coworkTools', async (orig) => ({
  ...(await orig<typeof import('../coworkTools')>()),
  buildCoworkTools,
}))

import { CoworkChatTransport } from '../coworkTransport'
import { CHAT_SLOT_ID, COWORK_SLOT_ID } from '@/constants/models'

const config = (over = {}) => ({
  planMode: false,
  webSearch: false,
  subagentNames: ['researcher'],
  allowSubagents: true,
  workspacePath: '/ws/s1',
  readOnlyFolder: null,
  ...over,
})

// Reaching in on purpose: these are protected seams whose whole job is to be
// different from the parent's, and both fail silently in production.
const slotParamsOf = (t: CoworkChatTransport, id: string) =>
  (t as unknown as {
    slotParams: (s?: string) => Record<string, unknown>
  }).slotParams(id)

describe('CoworkChatTransport', () => {
  beforeEach(() => {
    buildCoworkTools.mockReset()
    buildCoworkTools.mockResolvedValue({ read: {} })
    sandboxEnforces.mockReturnValue(true)
  })

  // Sharing slot 0 would have each of an agent turn's many prefills evict the
  // viewed chat thread's KV cache, and vice versa. Nothing surfaces that but a
  // slowdown, so it is asserted.
  it('pins to the Cowork slot, not the chat slot', () => {
    const t = new CoworkChatTransport('s1', config())
    const params = slotParamsOf(t, 's1')
    expect(params.id_slot).toBe(COWORK_SLOT_ID)
    expect(params.id_slot).not.toBe(CHAT_SLOT_ID)
    expect(params.thread_id).toBe('cowork:s1')
  })

  it('namespaces thread_id so a session cannot collide with a chat thread', () => {
    const t = new CoworkChatTransport('abc', config())
    expect(slotParamsOf(t, 'abc').thread_id).toBe('cowork:abc')
  })

  it('builds the tool set once and reuses it for the rest of the run', async () => {
    const t = new CoworkChatTransport('s1', config())
    await t.refreshTools()
    await t.refreshTools()
    await t.refreshTools()
    expect(buildCoworkTools).toHaveBeenCalledTimes(1)
  })

  // A config change must not take effect mid-run: it would change the tool JSON
  // and throw away the prompt prefix on the very next step.
  it('ignores a config change until the freeze is lifted', async () => {
    const t = new CoworkChatTransport('s1', config())
    await t.refreshTools()
    t.setConfig(config({ planMode: true }))
    await t.refreshTools()
    expect(buildCoworkTools).toHaveBeenCalledTimes(1)

    t.unfreezeTools()
    await t.refreshTools()
    expect(buildCoworkTools).toHaveBeenCalledTimes(2)
    expect(buildCoworkTools).toHaveBeenLastCalledWith(
      expect.objectContaining({ planMode: true })
    )
  })

  it('rebuilds when the sandbox appears, since bash joins the set', async () => {
    sandboxEnforces.mockReturnValue(false)
    const t = new CoworkChatTransport('s1', config())
    await t.refreshTools()
    sandboxEnforces.mockReturnValue(true)
    t.unfreezeTools()
    await t.refreshTools()
    expect(buildCoworkTools).toHaveBeenCalledTimes(2)
  })

  // The parent throws when a window has no user turn. That is right for chat,
  // where it means eviction ate the question, and wrong for a long agent run
  // whose recent traffic is all tool results.
  it('does not abort a window whose recent traffic is all tool results', () => {
    const t = new CoworkChatTransport('s1', config())
    expect(() =>
      (t as unknown as { assertSendable: (m: unknown[]) => void }).assertSendable(
        []
      )
    ).not.toThrow()
  })
})

describe('CoworkChatTransport.advertisedTools', () => {
  beforeEach(() => {
    buildCoworkTools.mockReset()
    buildCoworkTools.mockResolvedValue({ read: {}, task: {} })
    sandboxEnforces.mockReturnValue(true)
  })

  // A subagent's allowlist intersects with this, so plan mode and a withheld
  // `bash` reach children without a second policy check.
  it('reports the set frozen for the run', async () => {
    const t = new CoworkChatTransport('s1', config())
    await t.refreshTools()
    expect(Object.keys(t.advertisedTools)).toEqual(['read', 'task'])
  })

  it('is empty before a run advertises anything', () => {
    const t = new CoworkChatTransport('s1', config())
    expect(t.advertisedTools).toEqual({})
  })
})

describe('what the run reports it is sending', () => {
  beforeEach(() => {
    buildCoworkTools.mockReset()
    buildCoworkTools.mockResolvedValue({ read: {}, write: {} })
    sandboxEnforces.mockReturnValue(true)
  })

  const message = (text: string) =>
    ({ id: 'm', role: 'user', parts: [{ type: 'text', text }] }) as never

  /**
   * Dispatch a payload the way `sendMessages` does.
   *
   * Reaching in on purpose, exactly as this file already does for
   * `slotParams` and `assertSendable`: `onPayloadShaped` is a protected seam
   * whose entire job is to be called from inside the parent's send, and the
   * defect it exists to prevent is invisible from either side alone.
   */
  const dispatch = (
    t: CoworkChatTransport,
    payload: {
      system?: string
      before: unknown[]
      after: unknown[]
      kind?: 'unchanged' | 'trimmed' | 'compacted' | 'failed'
      reason?: string | null
    }
  ) =>
    (
      t as unknown as {
        onPayloadShaped: (d: Record<string, unknown>) => void
      }
    ).onPayloadShaped({
      system:
        payload.system ??
        (
          t as unknown as { buildSystemPrompt: (m: unknown[]) => string }
        ).buildSystemPrompt([]),
      before: payload.before,
      after: payload.after,
      kind: payload.kind ?? 'unchanged',
      reason: payload.reason ?? null,
    })

  const tokensOf = (v: { known: unknown; tokens?: number }) =>
    v.known === false ? 0 : (v.tokens ?? 0)
  const bytes = (text: string) => new TextEncoder().encode(text).length

  it('claims nothing at all before a payload has been dispatched', () => {
    // Not zero. A run that has not sent anything has not sent nothing, and the
    // difference is the whole reason `Measured` has three states.
    const t = new CoworkChatTransport('s1', config())
    const measured = t.measureContext(8192)

    expect(measured.categories.instructions).toEqual({ known: false })
    expect(measured.categories.conversation).toEqual({ known: false })
    expect(measured.categories.tools).toEqual({ known: false })
    expect(measured.shaping.kind).toBe('unknown')
    expect(measured.budget).toEqual(
      expect.objectContaining({ known: 'estimated', tokens: 8192 })
    )
  })

  it('measures the payload that was dispatched, never the one assembled', () => {
    // The defect this whole change exists for. `sendMessages` trims the window
    // after the caller has handed its messages over, so measuring what the
    // caller assembled described a conversation the model never received —
    // and it did so on exactly the long runs where the number matters.
    const t = new CoworkChatTransport('s1', config())
    const kept = message('kept'.repeat(50))
    const dropped = [message('dropped'.repeat(400)), message('also'.repeat(400))]

    dispatch(t, { before: [...dropped, kept], after: [kept], kind: 'trimmed' })
    const measured = t.measureContext(8192)

    const conversation = tokensOf(measured.categories.conversation)
    expect(conversation).toBe(Math.round(bytes('kept'.repeat(50)) / 4))

    // The mutation: measuring the assembled payload instead. If anyone routes
    // `measureContext` back through the pre-trim messages, this is the number
    // it would report, and it is not the number above.
    const assembled = Math.round(
      bytes('dropped'.repeat(400) + '\n' + 'also'.repeat(400) + '\n' + 'kept'.repeat(50)) /
        4
    )
    expect(conversation).not.toBe(assembled)
    expect(conversation).toBeLessThan(assembled)
  })

  it('reports what the trim took out, in messages and in size', () => {
    const t = new CoworkChatTransport('s1', config())
    const kept = message('kept')
    const dropped = message('x'.repeat(4000))

    dispatch(t, { before: [dropped, kept], after: [kept], kind: 'trimmed' })
    const { shaping } = t.measureContext()

    expect(shaping.kind).toBe('trimmed')
    expect(shaping.removed).toBe(1)
    expect(shaping.retained).toBe(1)
    expect(tokensOf(shaping.removedTokens)).toBeGreaterThan(900)
    expect(shaping.reason).toBeNull()
  })

  it('distinguishes a compaction from a plain trim', () => {
    const t = new CoworkChatTransport('s1', config())
    const summary = message('summary of earlier turns')
    dispatch(t, {
      before: [message('a'.repeat(3000)), message('b'.repeat(3000))],
      after: [summary],
      kind: 'compacted',
    })

    expect(t.lastShaping.kind).toBe('compacted')
    expect(t.lastShaping.removed).toBe(1)
    expect(t.lastShaping.retained).toBe(1)
  })

  it('says why a configured compaction did not happen', () => {
    // A failed compaction still sends — a trimmed window beats a lost turn —
    // but the window in force is then not the one that was configured, and
    // that is exactly the kind of quiet downgrade this surface exists to name.
    const t = new CoworkChatTransport('s1', config())
    dispatch(t, {
      before: [message('a'.repeat(3000)), message('b')],
      after: [message('b')],
      kind: 'failed',
      reason: 'model unavailable',
    })

    expect(t.lastShaping.kind).toBe('failed')
    expect(t.lastShaping.reason).toBe('model unavailable')
    expect(t.lastShaping.removed).toBe(1)
  })

  it('reports an untouched payload as sent whole, not as unknown', () => {
    const t = new CoworkChatTransport('s1', config())
    const messages = [message('one'), message('two')]
    dispatch(t, { before: messages, after: messages })

    expect(t.lastShaping).toEqual(
      expect.objectContaining({ kind: 'unchanged', removed: 0, retained: 2 })
    )
  })

  it('measures the prompt that went out, not one rebuilt from later config', () => {
    // Configuration edited mid-run applies to the next run. The accounting has
    // to follow the same rule, or the card describes a prompt that was never
    // sent.
    const t = new CoworkChatTransport('s1', config({ readOnlyFolder: '/repo' }))
    const system = (
      t as unknown as { buildSystemPrompt: (m: unknown[]) => string }
    ).buildSystemPrompt([])
    dispatch(t, { system, before: [], after: [] })

    const before = t.measureContext()
    t.setConfig(config({ readOnlyFolder: '/repo', repositoryMap: 'x'.repeat(4000) }))
    const after = t.measureContext()

    expect(after.categories.instructions).toEqual(before.categories.instructions)
    expect(tokensOf(after.categories.instructions)).toBe(
      Math.round(bytes(system) / 4)
    )
  })

  it('forgets the last dispatch at a run boundary', () => {
    // A new run showing the previous run's payload is a stale number that
    // looks exactly like a fresh one.
    const t = new CoworkChatTransport('s1', config())
    dispatch(t, { before: [message('hi')], after: [message('hi')] })
    expect(t.measureContext().shaping.kind).toBe('unchanged')

    t.forgetDispatch()
    expect(t.measureContext().shaping.kind).toBe('unknown')
    expect(t.measureContext().categories.conversation).toEqual({ known: false })
  })

  it('tells the run about each dispatch as it happens', () => {
    // Once per step, so a long run's card follows the payload rather than
    // reporting only what the last step happened to send.
    const t = new CoworkChatTransport('s1', config())
    const seen: unknown[] = []
    t.onDispatch = (accounting) => seen.push(accounting.shaping.kind)

    dispatch(t, { before: [message('a')], after: [message('a')] })
    dispatch(t, {
      before: [message('a'), message('b')],
      after: [message('b')],
      kind: 'trimmed',
    })

    expect(seen).toEqual(['unchanged', 'trimmed'])
  })

  it('reconciles: the categories sum to the payload that was sent', async () => {
    // The property the whole accounting rests on. If the parts do not add up
    // to the dispatched bytes, the total on the card is a number about nothing.
    const t = new CoworkChatTransport(
      's1',
      config({ repositoryMap: '# Repository map\n\nsrc/' })
    )
    await t.refreshTools()
    const system = (
      t as unknown as { buildSystemPrompt: (m: unknown[]) => string }
    ).buildSystemPrompt([])
    const sent = [message('hello'), message('world')]
    dispatch(t, { system, before: sent, after: sent })

    const measured = t.measureContext()
    const parts =
      tokensOf(measured.categories.instructions) +
      tokensOf(measured.categories.repositoryMap) +
      tokensOf(measured.categories.skills) +
      tokensOf(measured.categories.conversation) +
      tokensOf(measured.categories.tools)
    const payload =
      bytes(system) / 4 +
      bytes(JSON.stringify(t.advertisedTools)) / 4 +
      bytes('hello\nworld') / 4

    // Within rounding of each category, not approximately equal in spirit.
    expect(Math.abs(parts - payload)).toBeLessThanOrEqual(3)
  })

  it('measures the frozen tool set, not a rebuilt one', async () => {
    // A run's advertised set is frozen so the KV prefix survives. The reported
    // tool cost has to follow that same frozen set, or the card would report a
    // payload the model never received.
    const t = new CoworkChatTransport('s1', config())
    await t.refreshTools()
    dispatch(t, { before: [], after: [] })
    const before = t.measureContext()

    buildCoworkTools.mockResolvedValue({ read: {}, write: {}, bash: {}, edit: {} })
    await t.refreshTools()
    const after = t.measureContext()

    expect(after.categories.tools).toEqual(before.categories.tools)
  })

  it('never carries dispatched message text in what it reports', () => {
    // The record reaches the screen. A dropped message holds whatever the
    // conversation held — a pasted key, a path, a file — so the shaping record
    // carries counts and nothing else.
    const t = new CoworkChatTransport('s1', config())
    const secret = 'sk-not-a-real-key-0123456789'
    dispatch(t, {
      before: [message(secret), message('kept')],
      after: [message('kept')],
      kind: 'trimmed',
    })

    expect(JSON.stringify(t.measureContext().shaping)).not.toContain(secret)
  })
})
