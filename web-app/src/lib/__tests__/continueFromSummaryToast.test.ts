import { describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => ({
  loading: vi.fn(() => 'id'),
  dismiss: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))
const run = vi.hoisted(() => vi.fn())
vi.mock('@/lib/continueFromSummary', () => ({
  continueFromSummary: run,
  ContinueFromSummaryError: class extends Error {},
}))

import { continueFromSummaryWithToast } from '../continueFromSummaryToast'

describe('continueFromSummaryWithToast', () => {
  it('offers a cancel that aborts the summary and stays silent', async () => {
    let signal: AbortSignal | undefined
    run.mockImplementation(
      (_id: string, o: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal = o.signal
          o.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const onDone = vi.fn()
    continueFromSummaryWithToast('t1', (k) => k, onDone)
    const opts = (toastMock.loading.mock.calls[0] as unknown[])[1] as {
      cancel: { label: string; onClick: () => void }
    }
    expect(opts.cancel.label).toBe('chat:continueSummary.cancel')
    opts.cancel.onClick()
    expect(signal?.aborted).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })
})
