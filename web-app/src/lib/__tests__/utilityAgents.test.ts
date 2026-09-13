/**
 * Hidden utility agents (AH-208): no tools, not shown, always recorded, and
 * the record never holds what was said.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateText = vi.fn()
vi.mock('ai', () => ({
  generateText: (...a: unknown[]) => generateText(...a),
}))
const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))

import { runUtilityAgent } from '../utilityAgents'

const request = (over = {}) => ({
  kind: 'title' as const,
  session: 'thread-1',
  model: {} as never,
  modelId: 'pxa-27b',
  messages: [
    { role: 'user' as const, content: 'the user said something private' },
  ],
  maxOutputTokens: 64,
  ...over,
})

const recorded = () =>
  invoke.mock.calls
    .filter((c) => c[0] === 'utility_agent_record')
    .map((c) => c[1].record)

beforeEach(() => {
  generateText.mockReset()
  invoke.mockReset().mockResolvedValue(undefined)
})

describe('runUtilityAgent', () => {
  it('calls the model with no tools and tool use switched off', async () => {
    generateText.mockResolvedValue({
      text: 'Trip plan',
      usage: { inputTokens: 40, outputTokens: 3 },
    })
    await runUtilityAgent(request())
    const args = generateText.mock.calls[0][0]
    expect(args.tools).toBeUndefined()
    expect(args.toolChoice).toBe('none')
  })

  it('records a success with counts and without content', async () => {
    generateText.mockResolvedValue({
      text: 'Trip plan to Lisbon',
      usage: { inputTokens: 40, outputTokens: 3 },
    })
    expect(await runUtilityAgent(request())).toBe('Trip plan to Lisbon')
    const [entry] = recorded()
    expect(entry).toMatchObject({
      kind: 'title',
      session: 'thread-1',
      model: 'pxa-27b',
      outcome: 'succeeded',
      promptTokens: 40,
      completionTokens: 3,
      toolsOffered: false,
    })
    const serialized = JSON.stringify(entry)
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('Lisbon')
  })

  it('records a failure and still throws it to the caller', async () => {
    generateText.mockRejectedValue(new Error('server said no'))
    await expect(runUtilityAgent(request())).rejects.toThrow('server said no')
    expect(recorded()[0].outcome).toBe('failed')
    expect(JSON.stringify(recorded()[0])).not.toContain('server said no')
  })

  it('records a cancellation as cancelled, not as a failure', async () => {
    const controller = new AbortController()
    controller.abort()
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    generateText.mockRejectedValue(abort)
    await expect(
      runUtilityAgent(request({ abortSignal: controller.signal }))
    ).rejects.toThrow()
    expect(recorded()[0].outcome).toBe('cancelled')
  })

  it('never fails the call because the record could not be written', async () => {
    invoke.mockRejectedValue(new Error('no backend'))
    generateText.mockResolvedValue({ text: 'ok', usage: {} })
    await expect(runUtilityAgent(request())).resolves.toBe('ok')
  })
})
