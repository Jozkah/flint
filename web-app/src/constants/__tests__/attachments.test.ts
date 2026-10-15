import { describe, expect, it } from 'vitest'
import { isDocumentAttachmentName } from '../attachments'

describe('isDocumentAttachmentName', () => {
  it('accepts Dockerfile and Makefile, which have no extension', () => {
    expect(isDocumentAttachmentName('Dockerfile')).toBe(true)
    expect(isDocumentAttachmentName('C:\\repo\\Makefile')).toBe(true)
    expect(isDocumentAttachmentName('notes.md')).toBe(true)
    expect(isDocumentAttachmentName('README')).toBe(false)
  })
})
