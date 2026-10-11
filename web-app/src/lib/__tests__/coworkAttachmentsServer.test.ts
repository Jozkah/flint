import { describe, it, expect } from 'vitest'
import { submittedToRunAttachments } from '../coworkAttachments'

describe('media sent to a server session', () => {
  it('turns image data URLs into named base64 attachments', () => {
    const out = submittedToRunAttachments([
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,QUJD' },
      { type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,REVG' },
    ])
    expect(out.unsupported).toBe(0)
    expect(out.attachments).toEqual([
      { name: 'image-1.png', mime: 'image/png', data: 'QUJD' },
      { name: 'image-2.jpg', mime: 'image/jpeg', data: 'REVG' },
    ])
  })

  it('counts what cannot travel instead of dropping it silently', () => {
    const out = submittedToRunAttachments([
      { type: 'file', mediaType: 'audio/wav', url: 'data:audio/wav;base64,QUJD' },
      { type: 'file', mediaType: 'image/png', url: 'blob:https://x/1' },
    ])
    expect(out.attachments).toEqual([])
    expect(out.unsupported).toBe(2)
  })
})
