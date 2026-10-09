import { describe, it, expect } from 'vitest'
import { findSiblingMmproj, pickSiblingMmproj } from '../siblingMmproj'

describe('pickSiblingMmproj', () => {
  it('uses the only projector in the folder', () => {
    expect(
      pickSiblingMmproj('/m/gemma-3-4b-it-Q4_K_M.gguf', [
        '/m/gemma-3-4b-it-Q4_K_M.gguf',
        '/m/mmproj-gemma-3-4b-it-f16.gguf',
        '/m/readme.md',
      ])
    ).toBe('/m/mmproj-gemma-3-4b-it-f16.gguf')
  })

  it('picks the projector whose name matches when there are several', () => {
    expect(
      pickSiblingMmproj('C:\\m\\a-7b-Q4_K_M.gguf', [
        'C:\\m\\mmproj-b-3b-f16.gguf',
        'C:\\m\\mmproj-a-7b-f16.gguf',
      ])
    ).toBe('C:\\m\\mmproj-a-7b-f16.gguf')
  })

  it('refuses to guess between unrelated projectors', () => {
    expect(
      pickSiblingMmproj('/m/c.gguf', ['/m/mmproj-a.gguf', '/m/mmproj-b.gguf'])
    ).toBeNull()
  })

  it('finds none when the folder has no projector', () => {
    expect(pickSiblingMmproj('/m/c.gguf', ['/m/c.gguf'])).toBeNull()
  })
})

describe('findSiblingMmproj', () => {
  it('lists the model folder and swallows read errors', async () => {
    const seen: string[] = []
    const found = await findSiblingMmproj('/m/c.gguf', async (dir) => {
      seen.push(dir)
      return ['/m/mmproj-c.gguf']
    })
    expect(found).toBe('/m/mmproj-c.gguf')
    expect(seen).toEqual(['/m'])
    expect(
      await findSiblingMmproj('/m/c.gguf', async () => {
        throw new Error('denied')
      })
    ).toBeNull()
  })
})
