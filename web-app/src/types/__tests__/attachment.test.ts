import { describe, it, expect } from 'vitest'
import {
  createImageAttachment,
  createDocumentAttachment,
  createAudioAttachment,
  attachmentsToIngestAsImages,
  attachmentBase64,
} from '../attachment'

describe('attachmentBase64 (one stored format)', () => {
  it('derives the payload from the data URL of a new attachment', () => {
    const img = createImageAttachment({
      name: 'a.png',
      size: 3,
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,QUJD',
    })
    expect('base64' in img).toBe(false)
    expect(attachmentBase64(img)).toBe('QUJD')
  })

  it('still reads an older attachment that stored only base64', () => {
    expect(attachmentBase64({ base64: 'T0xE' })).toBe('T0xE')
    expect(
      attachmentBase64({ base64: 'T0xE', dataUrl: 'data:image/png;base64,TkVX' })
    ).toBe('T0xE')
  })

  it('is undefined with no content or a malformed URL', () => {
    expect(attachmentBase64({})).toBeUndefined()
    expect(attachmentBase64({ dataUrl: 'nocomma' })).toBeUndefined()
    expect(attachmentBase64({ dataUrl: 'data:image/png;base64,' })).toBeUndefined()
  })
})

// C025: a large paste becomes an inline text attachment; sending it to the
// image ingest raised "attachment is not image" on every paste.
describe('attachmentsToIngestAsImages', () => {
  it('keeps only images', () => {
    const img = createImageAttachment({
      name: 'a.png',
      size: 1,
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,x',
    })
    const doc = createDocumentAttachment({
      name: 'pasted-text-1.txt',
      path: 'pasted-text-1.txt',
    })
    expect(attachmentsToIngestAsImages([doc, img])).toEqual([img])
  })
})

describe('createImageAttachment', () => {
  it('returns an image-typed attachment with all provided fields', () => {
    const result = createImageAttachment({
      name: 'photo.png',
      dataUrl: 'data:image/png;base64,AAA',
      mimeType: 'image/png',
      size: 123,
    })
    expect(result).toEqual({
      name: 'photo.png',
      dataUrl: 'data:image/png;base64,AAA',
      mimeType: 'image/png',
      size: 123,
      type: 'image',
    })
  })
})

describe('createDocumentAttachment', () => {
  it('returns a document-typed attachment with required fields', () => {
    const result = createDocumentAttachment({
      name: 'report.pdf',
      path: '/tmp/report.pdf',
    })
    expect(result).toEqual({
      name: 'report.pdf',
      path: '/tmp/report.pdf',
      type: 'document',
    })
  })

  it('passes through optional fileType, size, parseMode (doc)', () => {
    const result = createDocumentAttachment({
      name: 'a.docx',
      path: '/a.docx',
      fileType: 'docx',
      size: 500,
      parseMode: 'embeddings',
    })
    expect(result.fileType).toBe('docx')
    expect(result.size).toBe(500)
    expect(result.parseMode).toBe('embeddings')
    expect(result.type).toBe('document')
  })
})

describe('createAudioAttachment', () => {
  it('returns an audio-typed attachment with wav format', () => {
    const result = createAudioAttachment({
      name: 'clip.wav',
      dataUrl: 'data:audio/wav;base64,QkJC',
      mimeType: 'audio/wav',
      audioFormat: 'wav',
      size: 2048,
      durationSec: 4.2,
    })
    expect(result).toEqual({
      name: 'clip.wav',
      dataUrl: 'data:audio/wav;base64,QkJC',
      mimeType: 'audio/wav',
      audioFormat: 'wav',
      size: 2048,
      durationSec: 4.2,
      type: 'audio',
    })
  })

  it('supports mp3 format and omits durationSec when unknown', () => {
    const result = createAudioAttachment({
      name: 'song.mp3',
      dataUrl: 'data:audio/mpeg;base64,YWFh',
      mimeType: 'audio/mpeg',
      audioFormat: 'mp3',
      size: 9001,
    })
    expect(result.type).toBe('audio')
    expect(result.audioFormat).toBe('mp3')
    expect(result.durationSec).toBeUndefined()
  })
})
