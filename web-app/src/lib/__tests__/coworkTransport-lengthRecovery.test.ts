/**
 * Cowork's pre-flight context check is lenient (sends a request over only by
 * the learned calibration) only when its run loop would compact and retry a
 * length refusal. Without that, the provider's raw refusal would end the run
 * in place of Flint's breakdown of what is large.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/agentTools', () => ({ sandboxEnforces: vi.fn(() => true) }))

import { CoworkChatTransport } from '../coworkTransport'

const config = {
  planMode: false,
  webSearch: false,
  subagentNames: [],
  allowSubagents: false,
  workspacePath: '/sandbox/sessions/s1',
  readOnlyFolder: '/work/api',
}

const available = (t: CoworkChatTransport) =>
  (t as unknown as { lengthRecoveryAvailable(): Promise<boolean> }).lengthRecoveryAvailable()

describe('Cowork length recovery for the pre-flight check', () => {
  it('is strict unless the run loop says it can compact and retry', async () => {
    const t = new CoworkChatTransport('s1', config)
    // A request the run loop did not mark (a send from outside it, a run with
    // no compaction wired): strict.
    expect(await available(t)).toBe(false)
  })

  it('is lenient for the one request the run loop marked, then strict again', async () => {
    const t = new CoworkChatTransport('s1', config)
    t.lengthRecoveryNext = true
    expect(await available(t)).toBe(true)
    // Spent: a fallback attempt or a later send does not inherit it.
    expect(await available(t)).toBe(false)
  })
})
