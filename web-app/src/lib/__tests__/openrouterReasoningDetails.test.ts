import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearReasoningDetails,
  withOpenRouterReasoningDetails,
} from '../openrouterReasoningDetails'

const sse = (events: unknown[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'

describe('OpenRouter reasoning_details round trip (#283)', () => {
  beforeEach(() => clearReasoningDetails())

  it('records details from a streamed tool call and replays them on the next request', async () => {
    const sent: Array<Record<string, any>> = []
    const first = sse([
      { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'a' }] } }] },
      { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'b' }] } }] },
      { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.encrypted', id: 'tool_1', data: 'SIG' }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool_1', function: { name: 'f', arguments: '' } }] } }] },
    ])
    const inner = (async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(sent.length === 1 ? first : sse([]), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    const f = withOpenRouterReasoningDetails(inner)

    const r1 = await f('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(await r1.text()).toBe(first)

    await f('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'tool_1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'tool_1', content: 'ok' },
        ],
      }),
    })
    expect(sent[1].messages[1].reasoning_details).toEqual([
      { type: 'reasoning.text', index: 0, text: 'ab' },
      { type: 'reasoning.encrypted', id: 'tool_1', data: 'SIG' },
    ])
    expect(sent[1].messages[0].reasoning_details).toBeUndefined()
  })

  it('records from a non-streaming JSON response', async () => {
    const sent: Array<Record<string, any>> = []
    const inner = (async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ id: 'c9' }], reasoning_details: [{ type: 'reasoning.encrypted', data: 'X' }] } }],
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch
    const f = withOpenRouterReasoningDetails(inner)
    await f('u', { method: 'POST', body: JSON.stringify({ messages: [] }) })
    await f('u', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'assistant', tool_calls: [{ id: 'c9' }] }] }),
    })
    expect(sent[1].messages[0].reasoning_details).toEqual([{ type: 'reasoning.encrypted', data: 'X' }])
  })

  it('leaves requests alone when nothing was recorded', async () => {
    let body = ''
    const f = withOpenRouterReasoningDetails((async (_u: unknown, init?: RequestInit) => {
      body = String(init?.body)
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)
    const original = JSON.stringify({ messages: [{ role: 'assistant', tool_calls: [{ id: 'zz' }] }] })
    await f('u', { method: 'POST', body: original })
    expect(body).toBe(original)
  })
})
