import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  rememberedWindowFor,
  resolveCompactionWindow,
} from '../compactionWindowSource'
import {
  listedWindow,
  recordListedWindows,
  resetListedWindows,
} from '../listedWindows'

describe('resolveCompactionWindow', () => {
  it('uses the configured or live window first, without asking anyone', async () => {
    const fetchServer = vi.fn()
    const r = await resolveCompactionWindow({
      known: 8192,
      provider: 32000,
      listed: 16000,
      remembered: 4000,
      fetchServer,
    })
    expect(r).toEqual({ tokens: 8192, source: 'configured' })
    expect(fetchServer).not.toHaveBeenCalled()
  })

  it('then what the provider describes', async () => {
    const r = await resolveCompactionWindow({
      known: 0,
      provider: 32000,
      listed: 16000,
      remembered: 4000,
    })
    expect(r).toEqual({ tokens: 32000, source: 'provider' })
  })

  it('then the window the endpoint listed', async () => {
    const r = await resolveCompactionWindow({
      known: 0,
      provider: null,
      listed: 16000,
      remembered: 4000,
    })
    expect(r).toEqual({ tokens: 16000, source: 'listed' })
  })

  it('then the last window this chat showed', async () => {
    const fetchServer = vi.fn()
    const r = await resolveCompactionWindow({
      known: 0,
      remembered: 4000,
      fetchServer,
    })
    expect(r).toEqual({ tokens: 4000, source: 'remembered' })
    expect(fetchServer).not.toHaveBeenCalled()
  })

  it('then asks the server', async () => {
    const r = await resolveCompactionWindow({
      known: 0,
      fetchServer: async () => 65536,
    })
    expect(r).toEqual({ tokens: 65536, source: 'server' })
  })

  it('reports none when nothing knows, including a server that fails', async () => {
    expect(await resolveCompactionWindow({ known: 0 })).toEqual({
      tokens: 0,
      source: 'none',
    })
    expect(
      await resolveCompactionWindow({
        known: 0,
        provider: 0,
        listed: -5,
        remembered: Number.NaN,
        fetchServer: async () => {
          throw new Error('down')
        },
      })
    ).toEqual({ tokens: 0, source: 'none' })
  })
})

describe('rememberedWindowFor', () => {
  const state = {
    windowById: { t1: 20000 },
    windowModelById: { t1: 'm1' },
    lastById: { t2: { window: 9000, model: 'm2' } },
  }

  it('returns the learned window for the same model', () => {
    expect(rememberedWindowFor(state, 't1', 'm1')).toBe(20000)
  })

  it('does not hand one model the window of another', () => {
    expect(rememberedWindowFor(state, 't1', 'other')).toBeNull()
    expect(rememberedWindowFor(state, 't2', 'other')).toBeNull()
  })

  it('falls back to the last shown window', () => {
    expect(rememberedWindowFor(state, 't2', 'm2')).toBe(9000)
  })

  it('is null for an unknown or missing thread', () => {
    expect(rememberedWindowFor(state, 'nope', 'm1')).toBeNull()
    expect(rememberedWindowFor(state, undefined, 'm1')).toBeNull()
  })
})

describe('listed windows', () => {
  beforeEach(() => resetListedWindows())

  it('keeps vLLM max_model_len from a /models payload', () => {
    recordListedWindows('http://gpu:8000/v1/', {
      data: [
        { id: 'qwen', max_model_len: 40960 },
        { id: 'other', context_length: 8192 },
        { id: 'none' },
      ],
    })
    expect(listedWindow('http://gpu:8000/v1', 'qwen')).toBe(40960)
    expect(listedWindow('http://gpu:8000/v1', 'other')).toBe(8192)
    expect(listedWindow('http://gpu:8000/v1', 'none')).toBeNull()
    expect(listedWindow('http://elsewhere/v1', 'qwen')).toBeNull()
  })

  it('ignores junk and missing arguments', () => {
    recordListedWindows('http://x/v1', null)
    recordListedWindows(undefined, { data: [{ id: 'a', max_model_len: 5 }] })
    recordListedWindows('http://x/v1', { data: [{ id: 'a', max_model_len: 0 }] })
    expect(listedWindow('http://x/v1', 'a')).toBeNull()
    expect(listedWindow(null, 'a')).toBeNull()
  })
})
