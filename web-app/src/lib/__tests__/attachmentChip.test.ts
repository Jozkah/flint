import { describe, it, expect } from 'vitest'
import {
  chipIcon,
  chipLabels,
  dragFileCount,
  formatChipSize,
  imageNeedsVision,
  isSendableAttachment,
  truncateMiddle,
} from '../attachmentChip'

describe('isSendableAttachment', () => {
  it('lets an inline document (large paste) send with an empty prompt', () => {
    expect(
      isSendableAttachment({
        name: 'pasted-text-1.txt',
        type: 'document',
        inlineContent: 'lots of text',
        processed: true,
      })
    ).toBe(true)
  })
  it('keeps media with bytes sendable and empty ones not', () => {
    expect(
      isSendableAttachment({ name: 'a.png', type: 'image', dataUrl: 'data:x' })
    ).toBe(true)
    expect(isSendableAttachment({ name: 'a.png', type: 'image' })).toBe(false)
  })
  it('rejects documents still processing, errored or empty', () => {
    expect(
      isSendableAttachment({ name: 'a.txt', type: 'document', inlineContent: 'x', processing: true })
    ).toBe(false)
    expect(
      isSendableAttachment({ name: 'a.txt', type: 'document', inlineContent: 'x', error: 'bad' })
    ).toBe(false)
    expect(isSendableAttachment({ name: 'a.txt', type: 'document' })).toBe(false)
  })
})

describe('attachmentChip', () => {
  it('middle-truncates and keeps the extension', () => {
    expect(truncateMiddle('a.txt')).toBe('a.txt')
    const out = truncateMiddle('quarterly-financial-report-final-v2.pdf', 24)
    expect(out.length).toBeLessThanOrEqual(24)
    expect(out.endsWith('.pdf')).toBe(true)
    expect(out).toContain('…')
    expect(out.startsWith('quarterly')).toBe(true)
  })

  it('formats sizes', () => {
    expect(formatChipSize(undefined)).toBe('')
    expect(formatChipSize(812)).toBe('812 B')
    expect(formatChipSize(1536)).toBe('1.5 KB')
    expect(formatChipSize(5 * 1024 * 1024)).toBe('5 MB')
  })

  it('maps types to icons', () => {
    expect(chipIcon({ type: 'image', name: 'a.png' })).toBe('image')
    expect(chipIcon({ type: 'audio', name: 'a.mp3' })).toBe('audio')
    expect(chipIcon({ type: 'document', name: 'a.pdf' })).toBe('pdf')
    expect(chipIcon({ type: 'document', name: 'a.ts' })).toBe('code')
    expect(chipIcon({ type: 'document', name: 'a.csv' })).toBe('sheet')
    expect(chipIcon({ type: 'document', name: 'a.zip' })).toBe('archive')
    expect(chipIcon({ type: 'document', name: 'a.weird' })).toBe('file')
  })

  it('names pasted images by order and leaves real names alone', () => {
    const labels = chipLabels(
      [
        { type: 'image', name: 'image.png' },
        { type: 'image', name: 'holiday.jpg' },
        { type: 'image', name: 'pasted-image-1700000000.png' },
      ],
      (n) => `Pasted image ${n}`
    )
    expect(labels).toEqual(['Pasted image 1', 'holiday.jpg', 'Pasted image 2'])
  })

  it('warns only for images on a model that cannot see', () => {
    expect(imageNeedsVision({ type: 'image' }, false)).toBe(true)
    expect(imageNeedsVision({ type: 'image' }, true)).toBe(false)
    expect(imageNeedsVision({ type: 'document' }, false)).toBe(false)
  })

  it('counts file items in a drag', () => {
    const dt = { items: [{ kind: 'file' }, { kind: 'string' }, { kind: 'file' }] }
    expect(dragFileCount(dt as unknown as DataTransfer)).toBe(2)
    expect(dragFileCount(null)).toBe(0)
  })
})
