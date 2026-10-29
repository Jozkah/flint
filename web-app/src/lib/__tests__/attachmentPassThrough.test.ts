import { describe, it, expect, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

import { passThroughMedia } from '@/lib/attachmentProcessing'
import type { Attachment } from '@/types/attachment'

describe('passThroughMedia', () => {
  it('marks audio then video ready and leaves other kinds out', () => {
    const list = [
      { name: 'v.mp4', type: 'video' },
      { name: 'a.mp3', type: 'audio' },
      { name: 'i.png', type: 'image' },
      { name: 'd.pdf', type: 'document' },
    ] as unknown as Attachment[]
    expect(passThroughMedia(list)).toEqual([
      { name: 'a.mp3', type: 'audio', processed: true, processing: false },
      { name: 'v.mp4', type: 'video', processed: true, processing: false },
    ])
  })
})
