import { describe, it, expect, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  i18n: { t: (key: string) => key },
}))

import { withMlxCrashReport } from '../mlxCrash'
import { parseEngineError } from '../engineError'

const crash = JSON.stringify({
  code: 'PROMPT_OUT_OF_MEMORY',
  message: 'The model ran out of GPU memory on this prompt.',
  details: '[metal::malloc] Attempting to allocate 21474836480 bytes',
})

describe('withMlxCrashReport', () => {
  it('replaces a network error with the crash of a dead server', async () => {
    const invoke = vi.fn().mockRejectedValue(crash)
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Load failed'))
    const f = withMlxCrashReport(fetchImpl, invoke, 42)

    const err = await f('http://x').catch((e) => e)
    expect(invoke).toHaveBeenCalledWith('plugin:mlx|is_mlx_process_running', {
      pid: 42,
    })
    expect(err.message).toContain('model-errors:engine.PROMPT_OUT_OF_MEMORY')
    expect(parseEngineError(err)?.code).toBe('PROMPT_OUT_OF_MEMORY')
  })

  it('reports a crash that breaks the streamed body', async () => {
    const invoke = vi.fn().mockRejectedValue(crash)
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true
          c.enqueue(new TextEncoder().encode('data: {}\n\n'))
        } else c.error(new TypeError('network error'))
      },
    })
    const f = withMlxCrashReport(
      vi.fn().mockResolvedValue(new Response(body)),
      invoke,
      7
    )
    const reader = (await f('http://x')).body!.getReader()
    await reader.read()
    const err = await reader.read().catch((e) => e)
    expect(parseEngineError(err)?.code).toBe('PROMPT_OUT_OF_MEMORY')
  })

  it('keeps the original error while the server is alive', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn().mockResolvedValue(true)
    const original = new TypeError('Load failed')
    const f = withMlxCrashReport(vi.fn().mockRejectedValue(original), invoke, 1)
    const pending = f('http://x').catch((e) => e)
    await vi.runAllTimersAsync()
    expect(await pending).toBe(original)
    vi.useRealTimers()
  })

  it('does not ask on an abort', async () => {
    const invoke = vi.fn()
    const ctrl = new AbortController()
    ctrl.abort()
    const original = new DOMException('aborted', 'AbortError')
    const f = withMlxCrashReport(vi.fn().mockRejectedValue(original), invoke, 1)
    expect(await f('http://x', { signal: ctrl.signal }).catch((e) => e)).toBe(
      original
    )
    expect(invoke).not.toHaveBeenCalled()
  })
})
