import type { UploadsService, UploadResult } from './types'
import { invokeCommand } from '@/lib/backend'
import type { Attachment } from '@/types/attachment'
import { ulid } from 'ulidx'
import { ExtensionManager } from '@/lib/extension'
import { ExtensionTypeEnum, type RAGExtension, type IngestAttachmentsResult } from '@janhq/core'

// FileReader rather than File.arrayBuffer: available wherever attachments are
// read, including the test DOM.
function readFileBytes(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`))
    reader.readAsArrayBuffer(file)
  })
}

export class DefaultUploadsService implements UploadsService {
  async saveDroppedFile(file: File, threadId?: string): Promise<string> {
    const bytes = new Uint8Array(await readFileBytes(file))
    // The bytes as the raw IPC body: no base64 copy a third larger than the
    // file, no JSON round trip. Header values must be ASCII, so the name is
    // percent-encoded. (`save_attachment_file` still takes base64.)
    return invokeCommand<string>('save_attachment_bytes', bytes, {
      headers: {
        'x-flint-file-name': encodeURIComponent(file.name),
        ...(threadId ? { 'x-flint-thread-id': threadId } : {}),
      },
    })
  }

  async ingestImage(_threadId: string, attachment: Attachment): Promise<UploadResult> {
    if (attachment.type !== 'image') throw new Error('ingestImage: attachment is not image')
    // Placeholder upload flow; swap for real API call when backend is ready
    await new Promise((r) => setTimeout(r, 100))
    return { id: ulid() }
  }

  async ingestFileAttachment(threadId: string, attachment: Attachment): Promise<UploadResult> {
    if (attachment.type !== 'document') throw new Error('ingestFileAttachment: attachment is not document')
    const ext = ExtensionManager.getInstance().get<RAGExtension>(ExtensionTypeEnum.RAG)
    if (!ext?.ingestAttachments) throw new Error('RAG extension not available')
    const res: IngestAttachmentsResult = await ext.ingestAttachments(threadId, [
      { path: attachment.path!, name: attachment.name, type: attachment.fileType, size: attachment.size },
    ])
    const files = res.files
    if (Array.isArray(files) && files[0]?.id) {
      return {
        id: files[0].id,
        size: typeof files[0].size === 'number' ? Number(files[0].size) : undefined,
        chunkCount: typeof files[0].chunk_count === 'number' ? Number(files[0].chunk_count) : undefined,
      }
    }
    throw new Error('Failed to resolve ingested attachment id')
  }

  async ingestFileAttachmentForProject(projectId: string, attachment: Attachment): Promise<UploadResult> {
    if (attachment.type !== 'document') throw new Error('ingestFileAttachmentForProject: attachment is not document')
    const ext = ExtensionManager.getInstance().get<RAGExtension>(ExtensionTypeEnum.RAG)
    if (!ext?.ingestAttachmentsForProject) throw new Error('RAG extension does not support project-level ingestion')
    const res: IngestAttachmentsResult = await ext.ingestAttachmentsForProject(projectId, [
      { path: attachment.path!, name: attachment.name, type: attachment.fileType, size: attachment.size },
    ])
    const files = res.files
    if (Array.isArray(files) && files[0]?.id) {
      return {
        id: files[0].id,
        size: typeof files[0].size === 'number' ? Number(files[0].size) : undefined,
        chunkCount: typeof files[0].chunk_count === 'number' ? Number(files[0].chunk_count) : undefined,
      }
    }
    throw new Error('Failed to resolve ingested attachment id')
  }
}
