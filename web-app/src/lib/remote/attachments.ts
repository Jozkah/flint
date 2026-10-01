// A phone's attachments, turned into what the desktop composer sends: media
// as file parts (images to vision models), documents staged by path for the
// usual parse / RAG path. The same validation the composer runs decides what
// is refused, and its reasons are what the phone shows.

import type { Attachment } from '@/types/attachment'
import { createDocumentAttachment } from '@/types/attachment'
import {
  DEFAULT_ATTACHMENT_LIMITS,
  reasonMessageKey,
  validateAttachment,
  type ModelCapabilities,
} from '@/lib/attachmentSupport'
import type { SubmittedFile } from '@/lib/coworkAttachments'
import type { RemoteUploadedFile } from './api'
import type { AttachmentRejection } from './protocol'

export type PlannedAttachments = {
  files: SubmittedFile[]
  docs: Attachment[]
  rejected: AttachmentRejection[]
}

export function planAttachments(
  uploads: readonly RemoteUploadedFile[],
  capabilities: ModelCapabilities,
  t: (key: string) => string,
  parseMode: Attachment['parseMode'] = 'auto'
): PlannedAttachments {
  const out: PlannedAttachments = { files: [], docs: [], rejected: [] }
  const names: string[] = []
  for (const u of uploads) {
    const decision = validateAttachment(
      { name: u.name, size: u.size, type: u.mime },
      { capabilities, limits: DEFAULT_ATTACHMENT_LIMITS, existingNames: names, intake: 'path' }
    )
    if (!decision.ok) {
      out.rejected.push({ name: u.name, reason: decision.reason, message: t(reasonMessageKey(decision.reason)) })
      continue
    }
    names.push(u.name)
    const media = decision.kind === 'image' || decision.kind === 'audio' || decision.kind === 'video'
    if (media) {
      if (!u.dataUrl) {
        out.rejected.push({ name: u.name, reason: 'empty', message: t(reasonMessageKey('empty')) })
        continue
      }
      out.files.push({ type: 'file', mediaType: u.mime, url: u.dataUrl })
    } else {
      out.docs.push(
        createDocumentAttachment({
          name: u.name,
          path: u.path,
          fileType: u.name.split('.').pop()?.toLowerCase(),
          size: u.size,
          parseMode,
        })
      )
    }
  }
  return out
}
