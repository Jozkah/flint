/**
 * Browser file uploads - a picked file is sent to the Flint server and the
 * server path it is stored at stands in for a desktop file path.
 */

import { browserApi } from '@/services/browserApi'
import { DefaultUploadsService } from './default'
import type { UploadResult } from './types'
import type { Attachment } from '@/types/attachment'

export type StoredUpload = { id: string; name: string; size: number; path: string }

export async function uploadFile(file: File): Promise<StoredUpload> {
  return browserApi<StoredUpload>(`/api/v1/uploads?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
}

export async function deleteUpload(id: string): Promise<void> {
  await browserApi<void>(`/api/v1/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

const EMBEDDINGS_UNAVAILABLE =
  'Embedding-based document search needs the local embedding model, which the browser build of Flint does not have yet. Attach the document inline instead.'

export class BrowserUploadsService extends DefaultUploadsService {
  async ingestFileAttachment(_threadId: string, attachment: Attachment): Promise<UploadResult> {
    void attachment
    throw new Error(EMBEDDINGS_UNAVAILABLE)
  }

  async ingestFileAttachmentForProject(
    _projectId: string,
    attachment: Attachment
  ): Promise<UploadResult> {
    void attachment
    throw new Error(EMBEDDINGS_UNAVAILABLE)
  }
}
