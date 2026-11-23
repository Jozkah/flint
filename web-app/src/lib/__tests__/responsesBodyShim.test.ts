import { describe, it, expect, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

import { withResponsesBodyShim } from '../model-factory'

const run = async (url: string, body: unknown) => {
  const base = vi.fn(async () => new Response('{}'))
  await withResponsesBodyShim(base as unknown as typeof fetch)(url, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  const init = (base.mock.calls[0] as unknown as [string, RequestInit])[1]
  return JSON.parse(init.body as string)
}

describe('withResponsesBodyShim', () => {
  it('spells the cap and the effort the Responses way', async () => {
    const out = await run('https://g/v1/responses', {
      model: 'm',
      max_tokens: 100,
      reasoning_effort: 'high',
    })
    expect(out).toEqual({
      model: 'm',
      max_output_tokens: 100,
      reasoning: { effort: 'high', summary: 'auto' },
    })
  })
  it('leaves other endpoints and Responses-spelled bodies alone', async () => {
    const chat = { model: 'm', max_tokens: 100, reasoning_effort: 'low' }
    expect(await run('https://g/v1/chat/completions', chat)).toEqual(chat)
    const native = { model: 'm', max_output_tokens: 5, reasoning: { effort: 'low' } }
    expect(await run('https://g/v1/responses', native)).toEqual(native)
  })
})
