import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({ invokeCommand: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/backend', () => ({ invokeCommand: h.invokeCommand }))

import { studioApi } from '../studio'

describe('studioApi', () => {
  it('reaches the backend through the shared command router', async () => {
    await expect(studioApi.status()).resolves.toEqual({ ok: true })
    expect(h.invokeCommand).toHaveBeenCalledWith('diffusion_status')
  })
})
