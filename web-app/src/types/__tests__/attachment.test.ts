import { describe, it, expect } from 'vitest'
import {
  createImageAttachment,
  createDocumentAttachment,
  createAudioAttachment,
  attachmentsToIngestAsImages,
} from '../attachment'

// C025: a large paste becomes an inline text attachment; sending it to the
// image ingest raised "attachment is not image" on every paste.
describe('attachmentsToIngestAsImages', () => {
  it('keeps only images', () => {
    const img = createImageAttachment({
      name: 'a.png',
      size: 1,
      mimeType: 'image/png',
      base64: 'x',
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
      base64: 'AAA',
      dataUrl: 'data:image/png;base64,AAA',
      mimeType: 'image/png',
      size: 123,
    })
    expect(result).toEqual({
      name: 'photo.png',
      base64: 'AAA',
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
      base64: 'QkJC',
      dataUrl: 'data:audio/wav;base64,QkJC',
      mimeType: 'audio/wav',
      audioFormat: 'wav',
      size: 2048,
      durationSec: 4.2,
    })
    expect(result).toEqual({
      name: 'clip.wav',
      base64: 'QkJC',
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
      base64: 'YWFh',
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
