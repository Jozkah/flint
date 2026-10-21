import { describe, it, expect, vi } from 'vitest'
import { preloadSkills } from '../coworkSubagentSkills'

const signal = new AbortController().signal

describe('preloadSkills', () => {
  it('reads each skill through the dispatcher as skill_read, in order', async () => {
    const dispatch = vi.fn(async (call) => ({ output: `body of ${(call.input as { name: string }).name}` }))
    const out = await preloadSkills(['a', 'b'], dispatch, signal)
    expect(dispatch.mock.calls.map((c) => [c[0].toolName, c[0].input])).toEqual([
      ['skill_read', { name: 'a' }],
      ['skill_read', { name: 'b' }],
    ])
    expect(out).toEqual({
      blocks: [
        '<preloaded-skill name="a">\nbody of a\n</preloaded-skill>',
        '<preloaded-skill name="b">\nbody of b\n</preloaded-skill>',
      ],
    })
  })
  it('names a skill that does not exist or is model-invocation-disabled', async () => {
    const dispatch = vi.fn(async (call) =>
      (call.input as { name: string }).name === 'ghost'
        ? { output: "ERROR: skill 'ghost' not found" }
        : { output: 'ok' }
    )
    const out = await preloadSkills(['a', 'ghost', 'c'], dispatch, signal)
    expect(out).toEqual({ error: expect.stringContaining("skill 'ghost'") })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
  it('turns a thrown dispatch into a launch error', async () => {
    const out = await preloadSkills(['a'], async () => { throw new Error('boom') }, signal)
    expect(out).toEqual({ error: expect.stringContaining('boom') })
  })
  it('refuses more than 32 before reading anything', async () => {
    const dispatch = vi.fn()
    const out = await preloadSkills(Array.from({ length: 33 }, (_, i) => `s${i}`), dispatch, signal)
    expect(out).toEqual({ error: expect.stringContaining('32') })
    expect(dispatch).not.toHaveBeenCalled()
  })
})
