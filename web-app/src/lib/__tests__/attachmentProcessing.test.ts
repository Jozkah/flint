import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  processAttachmentsForSend,
  type AttachmentProcessingResult,
} from '../attachmentProcessing'
import type { Attachment } from '@/types/attachment'

// Minimal mock for ServiceHub methods used by processAttachmentsForSend
const createMockServiceHub = (overrides: Record<string, unknown> = {}) => ({
  uploads: () => ({
    ingestImage: vi
      .fn()
      .mockResolvedValue({ id: 'img-1', size: 100 }),
    ingestFileAttachment: vi
      .fn()
      .mockResolvedValue({ id: 'doc-1', size: 500, chunkCount: 3 }),
    ingestFileAttachmentForProject: vi
      .fn()
      .mockResolvedValue({ id: 'proj-doc-1', size: 500, chunkCount: 5 }),
    ...overrides,
  }),
  rag: () => ({
    parseDocument: vi.fn().mockResolvedValue('parsed document text'),
  }),
})

const docAttachment = (overrides: Partial<Attachment> = {}): Attachment => ({
  name: 'report.pdf',
  type: 'document',
  path: '/tmp/report.pdf',
  fileType: 'pdf',
  ...overrides,
})

const imageAttachment = (overrides: Partial<Attachment> = {}): Attachment => ({
  name: 'photo.jpg',
  type: 'image',
  base64: 'abc123',
  mimeType: 'image/jpeg',
  ...overrides,
})

describe('processAttachmentsForSend', () => {
  const threadId = 'thread-1'

  describe('images', () => {
    it('ingests unprocessed images and returns them with id', async () => {
      const hub = createMockServiceHub()
      const img = imageAttachment()

      const result = await processAttachmentsForSend({
        attachments: [img],
        threadId,
        serviceHub: hub as any,
        parsePreference: 'auto',
      })

      expect(result.processedAttachments).toHaveLength(1)
      expect(result.processedAttachments[0].id).toBe('img-1')
      expect(result.processedAttachments[0].processed).toBe(true)
    })

    it('skips already-processed images', async () => {
      const hub = createMockServiceHub()
      const img = imageAttachment({ processed: true, id: 'existing-id' })

      const result = await processAttachmentsForSend({
        attachments: [img],
        threadId,
        serviceHub: hub as any,
        parsePreference: 'auto',
      })

      expect(result.processedAttachments[0].id).toBe('existing-id')
      expect(hub.uploads().ingestImage).not.toHaveBeenCalled()
    })
  })

  describe('documents — parseMode routing', () => {
    it('uses inline mode when parseMode is "inline"', async () => {
      const hub = createMockServiceHub()
      const doc = docAttachment({ parseMode: 'inline' })

      const result = await processAttachmentsForSend({
        attachments: [doc],
        threadId,
        serviceHub: hub as any,
        parsePreference: 'auto',
      })

      expect(result.processedAttachments[0].injectionMode).toBe('inline')
      expect(result.processedAttachments[0].inlineContent).toBe(
        'parsed document text'
      )
      expect(result.hasEmbeddedDocuments).toBe(false)
    })

    it('uses embeddings mode when parseMode is "embeddings"', async () => {
      const hub = createMockServiceHub()
      const doc = docAttachment({ parseMode: 'embeddings' })

      const result = await processAttachmentsForSend({
        attachments: [doc],
        threadId,
        serviceHub: hub as any,
        parsePreference: 'auto',
      })

      expect(result.processedAttachments[0].injectionMode).toBe('embeddings')
      expect(result.processedAttachments[0].id).toBe('doc-1')
      expect(result.hasEmbeddedDocuments).toBe(true)
    })

    it('falls back to embeddings when inline parsing fails', async () => {
      const failingParse = vi.fn().mockRejectedValue(new Error('parse failed'))
      const hub = {
        ...createMockServiceHub(),
        rag: () => ({ parseDocument: failingParse }),
      }
      const doc = docAttachment({ parseMode: 'inline' })

      const result = await processAttachmentsForSend({
        attachments: [doc],
        threadId,
        serviceHub: hub as any,
        parsePreference: 'auto',
      })

      // Falls back to embeddings since parsedContent is absent
      expect(result.processedAttachments[0].injectionMode).toBe('embeddings')
      expect(result.hasEmbeddedDocuments).toBe(true)
    })

    it('skips already-processed documents', async () => {
      const hub = createMockServiceHub()
      const doc = docAttachment({
        processed: true,
        id: 'existing-doc',
        injectionMode: 'embeddings',
      })

      const result = await processAttachmentsForSend({
        attachments: [doc],
        threadId,
        serviceHub: hub as any,
        parsePreference: 'auto',
      })

      expect(result.processedAttachments[0].id).toBe('existing-doc')
      expect(hub.uploads().ingestFileAttachment).not.toHaveBeenCalled()
    })

    it('forces embeddings for project files', async () => {
      const hub = createMockServiceHub()
      const doc = docAttachment({ parseMode: 'inline' })

      const result = await processAttachmentsForSend({
        attachments: [doc],
        threadId,
        projectId: 'proj-1',
        serviceHub: hub as any,
        parsePreference: 'auto',
      })

      expect(result.processedAttachments[0].injectionMode).toBe('embeddings')
      expect(result.processedAttachments[0].id).toBe('proj-doc-1')
    })
  })

  describe('auto mode with perFileChoices', () => {
    it('respects per-file user choice for auto-mode documents', async () => {
      const hub = createMockServiceHub()
      const doc = docAttachment({ parseMode: 'auto' })
      const choices = new Map<string, 'inline' | 'embeddings'>([
        ['/tmp/report.pdf', 'inline'],
      ])

      const result = await processAttachmentsForSend({
        attachments: [doc],
        threadId,
        serviceHub: hub as any,
        parsePreference: 'auto',
        perFileChoices: choices,
      })

      expect(result.processedAttachments[0].injectionMode).toBe('inline')
    })
  })

  describe('callbacks', () => {
    it('calls updateAttachmentProcessing for each document', async () => {
      const hub = createMockServiceHub()
      const doc = docAttachment({ parseMode: 'embeddings' })
      const updateFn = vi.fn()

      await processAttachmentsForSend({
        attachments: [doc],
        threadId,
        serviceHub: hub as any,
        parsePreference: 'auto',
        updateAttachmentProcessing: updateFn,
      })

      // Called with 'processing' then 'done'
      expect(updateFn).toHaveBeenCalledWith('report.pdf', 'processing')
      expect(updateFn).toHaveBeenCalledWith(
        'report.pdf',
        'done',
        expect.objectContaining({ processed: true, injectionMode: 'embeddings' })
      )
    })

    it('fires onIngestProgress for multi-file uploads', async () => {
      const hub = createMockServiceHub()
      const docs = [
        docAttachment({ name: 'a.pdf', path: '/a.pdf', parseMode: 'embeddings' }),
        docAttachment({ name: 'b.pdf', path: '/b.pdf', parseMode: 'embeddings' }),
      ]
      const progressFn = vi.fn()

      await processAttachmentsForSend({
        attachments: docs,
        threadId,
        serviceHub: hub as any,
        parsePreference: 'auto',
        onIngestProgress: progressFn,
      })

      // Initial: {completed: 0, total: 2}, then increments
      expect(progressFn).toHaveBeenCalledWith({ completed: 0, total: 2 })
      expect(progressFn).toHaveBeenCalledWith({ completed: 1, total: 2 })
      expect(progressFn).toHaveBeenCalledWith({ completed: 2, total: 2 })
    })
  })

  describe('mixed attachments', () => {
    it('processes images and documents together', async () => {
      const hub = createMockServiceHub()
      const img = imageAttachment()
      const doc = docAttachment({ parseMode: 'embeddings' })

      const result = await processAttachmentsForSend({
        attachments: [img, doc],
        threadId,
        serviceHub: hub as any,
        parsePreference: 'auto',
      })

      expect(result.processedAttachments).toHaveLength(2)
      expect(result.processedAttachments[0].type).toBe('image')
      expect(result.processedAttachments[1].type).toBe('document')
      expect(result.hasEmbeddedDocuments).toBe(true)
    })
  })
})

describe('ingestion routing helpers', () => {
  it('needsIngestionChoice asks for auto only without a budget', async () => {
    const { needsIngestionChoice } = await import('../attachmentProcessing')
    const doc = docAttachment()
    expect(needsIngestionChoice(doc, 'auto', false)).toBe(true)
    expect(needsIngestionChoice(doc, 'auto', true)).toBe(false)
    expect(needsIngestionChoice(doc, 'prompt', true)).toBe(true)
    expect(needsIngestionChoice(doc, 'inline', false)).toBe(false)
    expect(
      needsIngestionChoice(docAttachment({ processed: true }), 'prompt', false)
    ).toBe(false)
    expect(
      needsIngestionChoice(docAttachment({ parseMode: 'inline' }), 'auto', false)
    ).toBe(false)
  })

  it('resolveAutoInlineBudget is undefined without a window or ratio', async () => {
    const { resolveAutoInlineBudget } = await import('../attachmentProcessing')
    expect(resolveAutoInlineBudget(null, undefined, 0.75)).toBeUndefined()
    expect(resolveAutoInlineBudget({ id: 'm' }, undefined, 0)).toBeUndefined()
  })

  it('applyIngestionChoices records the pick as parseMode by path', async () => {
    const { applyIngestionChoices } = await import('../attachmentProcessing')
    const out = applyIngestionChoices(
      [docAttachment({ path: '/a' }), docAttachment({ path: '/b' })],
      new Map([['/a', 'inline']])
    )
    expect(out[0].parseMode).toBe('inline')
    expect(out[1].parseMode).toBeUndefined()
  })

  it('auto inlines a small document when a threshold and estimator are given', async () => {
    const hub = createMockServiceHub()
    const result = await processAttachmentsForSend({
      attachments: [docAttachment()],
      threadId: 't',
      serviceHub: hub as any,
      parsePreference: 'auto',
      contextThreshold: 1000,
      estimateTokens: async () => 10,
    })
    expect(result.processedAttachments[0].injectionMode).toBe('inline')
  })
})
