import { describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import { generateText } from 'ai'
const h = vi.hoisted(() => ({ remember: vi.fn() }))
vi.mock('@/lib/apiFormatMemory', () => ({ rememberApiFormat: (...a: unknown[]) => h.remember(...a) }))
import { ModelFactory } from '../model-factory'

describe('scripted server that only implements /v1/responses', () => {
  it('chat model needing Responses switches and remembers', async () => {
    const hits: string[] = []
    const srv = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`)
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        if (req.url === '/v1/responses') {
          res.end(JSON.stringify({ id: 'r1', object: 'response', created_at: 1, model: 'm', status: 'completed',
            output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'pong', annotations: [] }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }))
        } else {
          res.statusCode = 404
          res.end(JSON.stringify({ error: { message: 'This model is only supported in v1/responses and not in v1/chat/completions.', type: 'invalid_request_error' } }))
        }
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    const provider = { provider: 'scripted', base_url: `http://127.0.0.1:${port}/v1`, api_key: 'k', settings: [], models: [{ id: 'm' }] } as never
    const m = await ModelFactory.createModel('m', provider, {})
    const r = await generateText({ model: m, prompt: 'ping' })
    srv.close()
    expect(r.text).toBe('pong')
    expect(hits).toEqual(['POST /v1/chat/completions', 'POST /v1/responses'])
    expect(h.remember).toHaveBeenCalledWith('scripted', 'm', 'responses', 'chat')
  })
})
