import { describe, it, expect, vi, beforeEach } from 'vitest'

const { imageSearch } = vi.hoisted(() => ({ imageSearch: vi.fn() }))

vi.mock('@janhq/tauri-plugin-websearch-api', () => ({
  webSearch: vi.fn(),
  webFetch: vi.fn(),
  imageSearch,
}))

import { executeWebTool, WEB_TOOL_NAMES } from '@/lib/webSearchTool'

describe('image_search', () => {
  beforeEach(() => {
    imageSearch.mockReset()
  })

  it('is a native web tool', () => {
    expect(WEB_TOOL_NAMES.has('image_search')).toBe(true)
  })

  it('lists each image with the page it came from', async () => {
    imageSearch.mockResolvedValue([
      {
        title: 'Ugly Love [cover]',
        image_url: 'https://i.test/ugly-love.jpg',
        source_url: 'https://books.test/ugly-love',
      },
    ])
    const out = await executeWebTool('image_search', { query: 'Ugly Love cover', count: 3 })
    expect(imageSearch.mock.calls[0].slice(0, 2)).toEqual(['Ugly Love cover', 3])
    expect(out.content).toBe(
      '1. Ugly Love cover\n   image: https://i.test/ugly-love.jpg\n   page: https://books.test/ugly-love'
    )
  })

  it('tells the model to carry on when nothing was found', async () => {
    imageSearch.mockResolvedValue([])
    const out = await executeWebTool('image_search', { query: 'zzz' })
    expect(String(out.content)).toContain('No images found')
  })

  it('returns the backend error instead of throwing', async () => {
    imageSearch.mockImplementation(async () => {
      throw new Error('provider has no image search')
    })
    const out = await executeWebTool('image_search', { query: 'x' })
    expect(out.error).toBe('provider has no image search')
  })
})
