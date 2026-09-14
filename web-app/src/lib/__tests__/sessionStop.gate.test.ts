import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/toolActivity', () => ({
  recordToolActivity: vi.fn(async () => {}),
}))

import { gateStopSession, type StopGateContext } from '../sessionStopGate'
import type { MailSessionSummary } from '../sessionMailbox'

const peers: MailSessionSummary[] = [
  { id: 'B', displayName: 'Beta', status: 'running' },
  { id: 'I', displayName: 'Idle one', status: 'idle' },
]

const fake = () => ({
  listSessions: vi.fn(async () => peers),
  approveStop: vi.fn(async () => null),
})

const call = (input: unknown, id = 'call-1') => ({
  toolCallId: id,
  toolName: 'stop_session',
  input,
})

const ctx = (over: Partial<StopGateContext> = {}): StopGateContext => ({
  sessionId: 'A',
  mode: 'ask',
  onApprove: vi.fn(async () => true),
  ...over,
})

const codeOf = (out: { output: string } | null) =>
  out ? JSON.parse(out.output.replace(/^ERROR: /, '')).error.code : null

describe('stop_session approval gate', () => {
  let mailbox: ReturnType<typeof fake>
  beforeEach(() => {
    mailbox = fake()
  })

  it('asks the user, naming the session and the reason, and records only a yes', async () => {
    const c = ctx()
    const out = await gateStopSession(
      call({ session_id: 'B', reason: 'we both own src/x.ts' }),
      c,
      undefined,
      mailbox
    )
    expect(out).toBeNull()
    expect(c.onApprove).toHaveBeenCalledWith(
      'call-1',
      'stop_session',
      { session: 'Beta', session_id: 'B', reason: 'we both own src/x.ts' },
      undefined,
      undefined
    )
    expect(mailbox.approveStop).toHaveBeenCalledWith({
      sessionId: 'A',
      callId: 'call-1',
      targetSessionId: 'B',
      reason: 'we both own src/x.ts',
    })
  })

  it('asks in auto mode too: the mode never waives the prompt', async () => {
    const c = ctx({ mode: 'auto' })
    await gateStopSession(call({ session_id: 'B', reason: 'r' }), c, undefined, mailbox)
    expect(c.onApprove).toHaveBeenCalledTimes(1)
  })

  it('a denial records nothing and tells the model not to retry', async () => {
    const c = ctx({ onApprove: vi.fn(async () => false) })
    const out = await gateStopSession(call({ session_id: 'B', reason: 'r' }), c, undefined, mailbox)
    expect(out?.isError).toBe(true)
    expect(out?.output).toMatch(/did not allow/)
    expect(mailbox.approveStop).not.toHaveBeenCalled()
  })

  it('is refused in review (plan) mode and where nothing can ask (subagents)', async () => {
    const review = ctx({ mode: 'review' })
    const refused = await gateStopSession(call({ session_id: 'B', reason: 'r' }), review, undefined, mailbox)
    expect(refused?.output).toMatch(/review mode/)
    expect(review.onApprove).not.toHaveBeenCalled()

    const child = await gateStopSession(
      call({ session_id: 'B', reason: 'r' }),
      ctx({ onApprove: undefined }),
      undefined,
      mailbox
    )
    expect(codeOf(child)).toBe('not_available')
    expect(mailbox.approveStop).not.toHaveBeenCalled()
  })

  it('refuses another project, unknown, self and idle targets without prompting', async () => {
    const c = ctx()
    // Not listed = not in this project: the same refusal as an unknown id.
    expect(codeOf(await gateStopSession(call({ session_id: 'C-other-project', reason: 'r' }), c, undefined, mailbox))).toBe('unknown_session')
    expect(codeOf(await gateStopSession(call({ session_id: 'A', reason: 'r' }), c, undefined, mailbox))).toBe('self_target')
    expect(codeOf(await gateStopSession(call({ session_id: 'I', reason: 'r' }), c, undefined, mailbox))).toBe('target_not_running')
    expect(codeOf(await gateStopSession(call({ session_id: 'B', reason: '  ' }), c, undefined, mailbox))).toBe('invalid_reason')
    expect(codeOf(await gateStopSession(call({ session_id: 'B', reason: 'x'.repeat(501) }), c, undefined, mailbox))).toBe('invalid_reason')
    expect(codeOf(await gateStopSession(call({ reason: 'r' }), c, undefined, mailbox))).toBe('invalid_arguments')
    expect(c.onApprove).not.toHaveBeenCalled()
    expect(mailbox.approveStop).not.toHaveBeenCalled()
  })

  it('a run stopped while it waits withdraws the question and records nothing', async () => {
    const controller = new AbortController()
    const c = ctx({
      onApprove: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(true), 50)
          })
      ),
    })
    const pending = gateStopSession(call({ session_id: 'B', reason: 'r' }), c, controller.signal, mailbox)
    await new Promise((r) => setTimeout(r, 0))
    controller.abort('cancelled')
    const out = await pending
    expect(out?.output).toMatch(/stopped while it waited/)
    expect(mailbox.approveStop).not.toHaveBeenCalled()
  })
})
