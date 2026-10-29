import { useCallback } from 'react'
import { toast } from 'sonner'
import { ExtensionTypeEnum, fs, VectorDBExtension } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { DOCUMENT_ATTACHMENT_EXTENSIONS } from '@/constants/attachments'
import { withoutAttachment } from '@/lib/attachmentIntake'
import { type Attachment, createDocumentAttachment } from '@/types/attachment'
import { useAttachments } from '@/hooks/useAttachments'
import { useAttachmentIngestionPrompt } from '@/hooks/useAttachmentIngestionPrompt'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'

const ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES = 512 * 1024

/**
 * Documents on the composer's draft: attaching them from the picker or a
 * drop (size limit, duplicates, the inline-vs-embeddings question), and
 * taking any attachment back off, deleting an ingested one from the backend.
 */
export function useDocumentAttachments({
  attachmentsKey,
  currentThreadId,
  attachments,
}: {
  attachmentsKey: string
  currentThreadId: string | undefined
  /** The draft's attachments, as rendered (chips are removed by index). */
  attachments: Attachment[]
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const attachmentsEnabled = useAttachments((s) => s.enabled)
  const parsePreference = useAttachments((s) => s.parseMode)
  const maxFileSizeMB = useAttachments((s) => s.maxFileSizeMB)
  const setAttachmentsForThread = useChatAttachments((s) => s.setAttachments)

  const processNewDocumentAttachments = useCallback(
    async (docs: Attachment[]) => {
      if (!docs.length) return

      // Only collect the user's inline-vs-embeddings preference via the
      // dialog.  Actual ingestion is always deferred to send time
      // (processAttachmentsForSend inside processAndSendMessage).
      const docsNeedingPrompt = docs.filter((doc) => {
        if (doc.processed || doc.injectionMode) return false
        const preference = doc.parseMode ?? parsePreference
        return preference === 'prompt' || preference === 'auto'
      })

      if (docsNeedingPrompt.length > 0) {
        const choices = new Map<string, 'inline' | 'embeddings'>()
        for (let i = 0; i < docsNeedingPrompt.length; i++) {
          const doc = docsNeedingPrompt[i]
          const choice = await useAttachmentIngestionPrompt
            .getState()
            .showPrompt(
              doc,
              ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES,
              i,
              docsNeedingPrompt.length
            )

          if (!choice) {
            // User cancelled — remove all pending docs
            setAttachmentsForThread(attachmentsKey, (prev) =>
              prev.filter(
                (att) =>
                  !docsNeedingPrompt.some(
                    (d) => d.path && att.path && d.path === att.path
                  )
              )
            )
            return
          }

          if (doc.path) {
            choices.set(doc.path, choice)
          }
        }

        // Persist each document's chosen mode so processAttachmentsForSend
        // can pick it up at send time.
        if (choices.size > 0) {
          setAttachmentsForThread(attachmentsKey, (prev) =>
            prev.map((att) => {
              const mode = att.path ? choices.get(att.path) : undefined
              return mode ? { ...att, parseMode: mode } : att
            })
          )
        }
      }
    },
    [
      attachmentsKey,
      parsePreference,
      setAttachmentsForThread,
    ]
  )

  /** Attach files on disk as documents; shared by the picker and drag-and-drop. */
  const attachDocumentPaths = async (paths: string[]) => {
    // Prepare attachments with file sizes
    const preparedAttachments: Attachment[] = []
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() || p
      const fileType = name.split('.').pop()?.toLowerCase()
      let size: number | undefined = undefined
      try {
        const stat = await fs.fileStat(p)
        size = stat?.size ? Number(stat.size) : undefined
      } catch (e) {
        console.warn('Failed to read file size for', p, e)
      }
      preparedAttachments.push(
        createDocumentAttachment({
          name,
          path: p,
          fileType,
          size,
          parseMode: parsePreference,
        })
      )
    }

    const maxFileSizeBytes =
      typeof maxFileSizeMB === 'number' && maxFileSizeMB > 0
        ? maxFileSizeMB * 1024 * 1024
        : undefined

    if (maxFileSizeBytes !== undefined) {
      const hasOversized = preparedAttachments.some(
        (att) => typeof att.size === 'number' && att.size > maxFileSizeBytes
      )
      if (hasOversized) {
        toast.error(t('sweep:chat.fileTooLarge'), {
          description: t('sweep:chat.fileTooLargeDesc', { size: maxFileSizeMB }),
        })
        return
      }
    }

    let duplicates: string[] = []
    let newDocAttachments: Attachment[] = []

    setAttachmentsForThread(attachmentsKey, (currentAttachments) => {
      const existingPaths = new Set(
        currentAttachments
          .filter((a) => a.type === 'document' && a.path)
          .map((a) => a.path)
      )

      duplicates = []
      newDocAttachments = []

      for (const att of preparedAttachments) {
        if (existingPaths.has(att.path)) {
          duplicates.push(att.name)
          continue
        }
        newDocAttachments.push(att)
      }

      return newDocAttachments.length > 0
        ? [...currentAttachments, ...newDocAttachments]
        : currentAttachments
    })

    if (duplicates.length > 0) {
      toast.warning(t('sweep:chat.filesAlreadyAttached'), {
        description: t('sweep:chat.alreadyInList', { names: duplicates.join(', '), count: duplicates.length }),
      })
    }

    if (newDocAttachments.length > 0) {
      await processNewDocumentAttachments(newDocAttachments)
    }
  }

  /** Save dropped documents to disk, then attach them like picked files. */
  const attachDroppedDocuments = async (files: File[]) => {
    if (!attachmentsEnabled) {
      toast.info(t('sweep:chat.attachmentsDisabled'))
      return
    }
    const limitBytes =
      typeof maxFileSizeMB === 'number' && maxFileSizeMB > 0
        ? maxFileSizeMB * 1024 * 1024
        : undefined
    const withinLimit = files.filter(
      (f) => limitBytes === undefined || f.size <= limitBytes
    )
    if (withinLimit.length < files.length) {
      toast.error(t('sweep:chat.fileTooLarge'), {
        description: t('sweep:chat.fileTooLargeDesc', { size: maxFileSizeMB }),
      })
    }
    if (withinLimit.length === 0) return
    try {
      const paths = await Promise.all(
        withinLimit.map((f) =>
          serviceHub.uploads().saveDroppedFile(f, currentThreadId)
        )
      )
      await attachDocumentPaths(paths)
    } catch (e) {
      console.error('Failed to attach dropped documents:', e)
      toast.error(t('common:dropAttachFailed'), {
        description: e instanceof Error ? e.message : JSON.stringify(e),
      })
    }
  }

  const handleAttachDocsIngest = async () => {
    try {
      if (!attachmentsEnabled) {
        toast.info(t('sweep:chat.attachmentsDisabled'))
        return
      }
      const selection = await serviceHub.dialog().open({
        multiple: true,
        filters: [
          {
            name: t('chat:composer.filterDocuments'),
            extensions: [...DOCUMENT_ATTACHMENT_EXTENSIONS],
          },
          {
            name: t('chat:composer.filterAll'),
            extensions: ['*'],
          },
        ],
      })
      if (!selection) return
      const paths = Array.isArray(selection) ? selection : [selection]
      if (!paths.length) return
      await attachDocumentPaths(paths)
    } catch (e) {
      console.error('Failed to attach documents:', e)
      const desc = e instanceof Error ? e.message : JSON.stringify(e)
      toast.error(t('chat:composer.attachFailed'), { description: desc })
    }
  }

  /**
   * Deletes an ingested document from the vector store. False (after a toast)
   * when the backend refused, so the chip has to stay.
   */
  const deleteAttachmentFromBackend = async (
    attachment: Attachment,
    threadId: string | undefined
  ): Promise<boolean> => {
    if (!attachment.id || !threadId || attachment.type !== 'document') {
      return true
    }
    try {
      const vectorDBExtension = ExtensionManager.getInstance().get(
        ExtensionTypeEnum.VectorDB
      ) as VectorDBExtension | undefined
      if (vectorDBExtension?.deleteFile) {
        await vectorDBExtension.deleteFile(threadId, attachment.id)
      }
      return true
    } catch (error) {
      console.error('Failed to delete attachment from backend:', error)
      toast.error(t('chat:composer.removeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  const handleRemoveAttachment = async (indexToRemove: number) => {
    const attachmentToRemove = attachments[indexToRemove]
    if (!attachmentToRemove) return
    // If attachment was ingested (has an ID), delete it from the backend
    if (
      attachmentToRemove.id &&
      !(await deleteAttachmentFromBackend(attachmentToRemove, currentThreadId))
    )
      return
    setAttachmentsForThread(attachmentsKey, (prev) =>
      withoutAttachment(prev, attachmentToRemove)
    )
  }

  /**
   * Backspace in an empty box: the chip goes at once and a toast offers to
   * put it back. An ingested document is only deleted from the backend once
   * the toast closes without an undo; if that delete fails the chip returns.
   */
  const removeAttachmentWithUndo = (index: number) => {
    const target = attachments[index]
    if (!target) return
    const key = attachmentsKey
    const threadId = currentThreadId
    const restore = () =>
      setAttachmentsForThread(key, (prev) =>
        prev.includes(target)
          ? prev
          : [...prev.slice(0, index), target, ...prev.slice(index)]
      )
    setAttachmentsForThread(key, (prev) => withoutAttachment(prev, target))
    let settled = false
    const finalize = () => {
      if (settled) return
      settled = true
      void deleteAttachmentFromBackend(target, threadId).then((ok) => {
        if (!ok) restore()
      })
    }
    toast.info(t('chat:composer.attachmentRemoved', { name: target.name }), {
      action: {
        label: t('common:undo'),
        onClick: () => {
          if (settled) return
          settled = true
          restore()
        },
      },
      onAutoClose: finalize,
      onDismiss: finalize,
    })
  }

  return {
    attachDocumentPaths,
    attachDroppedDocuments,
    handleAttachDocsIngest,
    handleRemoveAttachment,
    removeAttachmentWithUndo,
  }
}
