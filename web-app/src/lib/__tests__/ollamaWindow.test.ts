import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/providerFetch', () => ({ providerFetch: h.fetch }))

import {
  fetchOllamaWindow,
  isOllamaProvider,
  parsePsWindow,
  parseShowWindow,
  resetOllamaWindowState,
  shouldNoticeOllamaTruncation,
} from '@/lib/ollamaWindow'
import { resolveCompactionWindow } from '@/lib/compactionWindowSource'

const answer = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) })

describe('Ollama window', () => {
  beforeEach(() => {
    resetOllamaWindowState()
    h.fetch.mockReset()
  })

  it('recognises an Ollama provider by name or default port only', () => {
    expect(isOllamaProvider({ provider: 'ollama' })).toBe(true)
    expect(isOllamaProvider({ provider: 'x', base_url: 'http://192.168.1.9:11434/v1' })).toBe(true)
    expect(isOllamaProvider({ provider: 'lmstudio', base_url: 'http://localhost:1234/v1' })).toBe(false)
    expect(isOllamaProvider({ provider: 'openai', base_url: 'https://api.openai.com/v1' })).toBe(false)
    expect(isOllamaProvider(undefined)).toBe(false)
  })

  it('reads the loaded context of the model, matching the :latest tag', () => {
    const ps = { models: [{ name: 'llama3:latest', model: 'llama3:latest', context_length: 4096 }] }
    expect(parsePsWindow(ps, 'llama3')).toBe(4096)
    expect(parsePsWindow(ps, 'qwen3:8b')).toBeNull()
    expect(parsePsWindow({}, 'llama3')).toBeNull()
  })

  it('reads a Modelfile num_ctx, never the trained maximum', () => {
    expect(parseShowWindow({ parameters: 'stop "<|eot|>"\nnum_ctx                        8192' })).toBe(8192)
    expect(parseShowWindow({ model_info: { 'llama.context_length': 131072 } })).toBeNull()
  })

  it('asks /api/ps at the origin, then /api/show', async () => {
    h.fetch
      .mockReturnValueOnce(answer({ models: [] }))
      .mockReturnValueOnce(answer({ parameters: 'num_ctx 16384' }))
    expect(await fetchOllamaWindow('http://10.0.0.2:11434/v1', 'llama3')).toBe(16384)
    expect(h.fetch.mock.calls[0][0]).toBe('http://10.0.0.2:11434/api/ps')
    expect(h.fetch.mock.calls[1][0]).toBe('http://10.0.0.2:11434/api/show')
    expect(JSON.parse(h.fetch.mock.calls[1][1].body)).toEqual({ model: 'llama3' })
  })

  it('falls back silently when the server is unreachable', async () => {
    h.fetch.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await fetchOllamaWindow('http://10.0.0.2:11434/v1', 'llama3')).toBeNull()
    const resolved = await resolveCompactionWindow({
      known: 0,
      provider: 131072,
      fetchLoaded: () => fetchOllamaWindow('http://10.0.0.3:11434/v1', 'llama3'),
    })
    expect(resolved).toEqual({ tokens: 131072, source: 'provider' })
  })

  it('window resolution prefers the loaded context over the described one', async () => {
    h.fetch.mockReturnValueOnce(
      answer({ models: [{ name: 'llama3:latest', context_length: 4096 }] })
    )
    const resolved = await resolveCompactionWindow({
      known: 0,
      provider: 131072,
      listed: 131072,
      fetchLoaded: () => fetchOllamaWindow('http://10.0.0.2:11434/v1', 'llama3'),
    })
    expect(resolved).toEqual({ tokens: 4096, source: 'server' })
  })

  it('a configured window still wins, and no loader leaves others unchanged', async () => {
    const fetchLoaded = vi.fn(async () => 4096)
    expect(await resolveCompactionWindow({ known: 32768, fetchLoaded })).toEqual({
      tokens: 32768,
      source: 'configured',
    })
    expect(fetchLoaded).not.toHaveBeenCalled()
    expect(await resolveCompactionWindow({ known: 0, provider: 131072 })).toEqual({
      tokens: 131072,
      source: 'provider',
    })
  })

  it('notices truncation once, at the threshold', () => {
    expect(shouldNoticeOllamaTruncation('t|m', 3000, 4096)).toBe(false)
    expect(shouldNoticeOllamaTruncation('t|m', 3800, 4096)).toBe(true)
    expect(shouldNoticeOllamaTruncation('t|m', 5000, 4096)).toBe(false)
    expect(shouldNoticeOllamaTruncation('t2|m', 5000, null)).toBe(false)
  })
})
