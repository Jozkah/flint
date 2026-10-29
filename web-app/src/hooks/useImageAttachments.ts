import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { toAssetUrl } from '@/lib/assetPath'
import { isPlatformTauri } from '@/lib/platform/utils'
import { fitImageFileToLimit } from '@/lib/imageResize'
import { readFileAsText } from '@/lib/fileSafety'
import {
  DEFAULT_ATTACHMENT_LIMITS,
  isTextual,
  validateAttachment,
  visionBlockedFiles,
  type ModelCapabilities,
  type RejectionReason,
} from '@/lib/attachmentSupport'
import { pickedImageMime, rejectionLines } from '@/lib/composerIntake'
import { prepareImageFiles, splitNewImages } from '@/lib/attachmentIntake'
import { ingestImagesInOrder } from '@/lib/imageIngest'
import {
  type Attachment,
  attachmentsToIngestAsImages,
  createDocumentAttachment,
} from '@/types/attachment'
import type { EnableableCapability } from '@/lib/modelCapabilityEnable'
import type { VisionDisabledChoice } from '@/containers/dialogs/VisionDisabledDialog'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'

type ProcessImageOptions = {
  /**
   * The model's media capabilities, when they must not be read from the
   * store. Enabling vision and re-running in the same tick would otherwise
   * see the capabilities this render closed over -- the old ones.
   */
  capabilities?: ModelCapabilities
  /** The vision question has been asked and answered; do not ask again. */
  visionAsked?: boolean
}

/**
 * An attach that is waiting on the user, because the model cannot read the
 * images in it. The whole batch is held, not just the pictures: cancelling
 * has to leave the draft exactly as it was, which it cannot do if the text
 * files have already been read and attached.
 */
export type VisionPrompt = {
  files: File[]
  blocked: File[]
  canEnable: boolean
}

/**
 * Attaching images and text files picked, dropped or pasted into the
 * composer: reading and validating them, asking first when the model cannot
 * see, adding the new ones to the draft and ingesting the images.
 */
export function useImageAttachments({
  attachmentsKey,
  currentThreadId,
  selectedModel,
  selectedProvider,
  maxFileSizeMB,
  setMessage,
  focusComposer,
  enableCapabilities,
}: {
  attachmentsKey: string
  currentThreadId: string | undefined
  selectedModel: { id?: string; capabilities?: string[] } | undefined | null
  selectedProvider: string | undefined
  maxFileSizeMB: number | undefined
  setMessage: (message: string) => void
  focusComposer: () => void
  /** Turn capabilities on for the selected model; false when it could not. */
  enableCapabilities: (capabilities: readonly EnableableCapability[]) => boolean
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const setAttachmentsForThread = useChatAttachments((s) => s.setAttachments)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [visionPrompt, setVisionPrompt] = useState<VisionPrompt | null>(null)

  const openVisionPrompt = useCallback(
    async (files: File[], blocked: File[]) => {
      // Offering to turn vision on is only honest where it would work. A
      // llama.cpp model sees through an mmproj file; without one the switch
      // buys nothing but a request that fails later, so the option is withheld
      // and the reason shown instead.
      let canEnable = true
      if (selectedProvider === 'llamacpp' && selectedModel?.id) {
        try {
          canEnable = await serviceHub
            .models()
            .checkMmprojExists(selectedModel.id)
        } catch (error) {
          console.error('Failed to check mmproj support:', error)
          canEnable = false
        }
      }
      setVisionPrompt({ files, blocked, canEnable })
    },
    [selectedModel?.id, selectedProvider, serviceHub]
  )

  const processImageFiles = useCallback(
    async (inputFiles: File[], options?: ProcessImageOptions) => {
      // The user's "max file size" setting, in bytes, when there is one.
      const userMaxBytes =
        typeof maxFileSizeMB === 'number' && maxFileSizeMB > 0
          ? maxFileSizeMB * 1024 * 1024
          : undefined
      // A large screenshot is re-encoded down to this, never above the setting.
      const maxSize = Math.min(10 * 1024 * 1024, userMaxBytes ?? Infinity)
      // A large screenshot is re-encoded to fit rather than refused.
      const files = await Promise.all(
        Array.from(inputFiles).map((file) => fitImageFileToLimit(file, maxSize))
      )

      const validFiles: File[] = []
      const textFiles: File[] = []
      // Each rejection keeps its own reason, so the message can say which of
      // several possible problems this file actually had.
      const rejected: { name: string; reason: RejectionReason }[] = []

      const capabilities = options?.capabilities ?? {
        vision: Boolean(selectedModel?.capabilities?.includes('vision')),
        audio: Boolean(selectedModel?.capabilities?.includes('audio')),
        video: Boolean(selectedModel?.capabilities?.includes('video')),
      }
      // The size a file may be is the user's "max file size" setting, not the
      // image re-encode target above: 10MB here refused a 50MB text or code
      // file for people who had set 200MB.
      const limits = {
        maxBytes: userMaxBytes ?? DEFAULT_ATTACHMENT_LIMITS.maxBytes,
        maxCount: DEFAULT_ATTACHMENT_LIMITS.maxCount,
      }

      // An image handed to a model that cannot see is a question, not an
      // error. Dropping it silently threw away something the user had already
      // decided mattered, and the model's own metadata is often just
      // incomplete -- a manually added OpenAI-compatible endpoint rarely
      // declares vision even when it has it. Ask before anything is read, so a
      // cancel leaves nothing behind.
      if (!options?.visionAsked) {
        const blocked = visionBlockedFiles(files, { capabilities, limits })
        if (blocked.length > 0) {
          void openVisionPrompt(files, blocked)
          return
        }
      }

      Array.from(files).forEach((file) => {
        const decision = validateAttachment(file, { capabilities, limits })
        if (!decision.ok) {
          rejected.push({ name: file.name, reason: decision.reason })
          return
        }
        // Text and code are read as text and travel through the document
        // pipeline; raw bytes are never handed to a model.
        if (isTextual(decision.kind)) textFiles.push(file)
        else if (decision.kind === 'image') validFiles.push(file)
        else rejected.push({ name: file.name, reason: 'unsupported' })
      })

      const preparedFiles: Attachment[] = []

      // Text and code arrive as text, not bytes. They become inline document
      // attachments, which is the path the model already understands, and
      // which is why they need nothing of its media capabilities.
      for (const file of textFiles) {
        // Classification is by extension, so the bytes get the deciding vote:
        // a renamed binary or a credentials file is refused here, not sent.
        const read = await readFileAsText(file)
        if (!read.ok) {
          rejected.push({ name: file.name, reason: read.reason })
          continue
        }
        preparedFiles.push({
          ...createDocumentAttachment({
            name: file.name,
            path: file.name,
            fileType: file.name.split('.').pop(),
            size: file.size,
            parseMode: 'inline',
          }),
          inlineContent: read.text,
          injectionMode: 'inline',
          processed: true,
        })
      }
      const images = await prepareImageFiles(validFiles)
      for (const name of images.unreadable) {
        // One unreadable file must not stall the rest of the batch.
        rejected.push({ name, reason: 'unreadable' })
      }
      preparedFiles.push(...images.prepared)

      const currentAttachments = useChatAttachments
        .getState()
        .getAttachments(attachmentsKey)

      const { fresh: newFiles, duplicates } = await splitNewImages(
        preparedFiles,
        currentAttachments
      )

      setAttachmentsForThread(attachmentsKey, (prev) =>
        newFiles.length > 0 ? [...prev, ...newFiles] : prev
      )

      // Only images go to the image ingest: an inline text or document
      // attachment is already complete and the ingest rejects it (C025).
      const imagesToIngest = attachmentsToIngestAsImages(newFiles)
      const threadId = currentThreadId
      if (threadId && imagesToIngest.length > 0) {
        void ingestImagesInOrder(imagesToIngest, {
          ingest: (img) => serviceHub.uploads().ingestImage(threadId, img),
          update: (fn) => setAttachmentsForThread(attachmentsKey, fn),
          onFailed: (img, error) =>
            toast.error(t('chat:composer.ingestFailed', { name: img.name }), {
              description:
                error instanceof Error ? error.message : String(error),
            }),
        })
      }

      if (duplicates.length > 0) {
        toast.warning(t('chat:composer.dupImages'), {
          description: t('sweep:chat.alreadyInList', {
            count: duplicates.length,
            names: duplicates.join(', '),
          }),
        })
      }

      // One line per reason, naming the files it applies to.
      const errors = rejectionLines(rejected, t)

      if (errors.length > 0) {
        setMessage(errors.join(' | '))
        // Reset file input to allow re-uploading
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
      } else {
        setMessage('')
      }
    },
    [
      attachmentsKey,
      currentThreadId,
      setAttachmentsForThread,
      serviceHub,
      selectedModel?.capabilities,
      openVisionPrompt,
      maxFileSizeMB,
      setMessage,
      t,
    ]
  )

  /** Act on the answer to the vision question, then let the attach finish. */
  const handleVisionChoice = useCallback(
    async (choice: VisionDisabledChoice) => {
      const pending = visionPrompt
      setVisionPrompt(null)
      if (!pending) return

      // The picker keeps its last selection, so it has to be cleared or the
      // same file cannot be chosen again.
      if (fileInputRef.current) fileInputRef.current.value = ''

      if (choice === 'cancel') return

      if (choice === 'proceed') {
        const blocked = new Set(pending.blocked)
        const rest = pending.files.filter((file) => !blocked.has(file))
        if (rest.length > 0)
          await processImageFiles(rest, { visionAsked: true })
        return
      }

      if (!enableCapabilities(['vision'])) return
      await processImageFiles(pending.files, {
        visionAsked: true,
        // The store update lands in the next render; this call must not wait
        // for it, so the new capability is passed in directly.
        capabilities: {
          vision: true,
          audio: Boolean(selectedModel?.capabilities?.includes('audio')),
          video: Boolean(selectedModel?.capabilities?.includes('video')),
        },
      })
    },
    [
      enableCapabilities,
      processImageFiles,
      selectedModel?.capabilities,
      visionPrompt,
    ]
  )

  /** Attach files; the `onChange` of the hidden input and every other route in. */
  const attachFiles = (files: ArrayLike<File> | null | undefined) => {
    if (files && files.length > 0) {
      void processImageFiles(Array.from(files))
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
    focusComposer()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) =>
    attachFiles(e.target.files)

  // Open the image picker dialog
  const openImagePicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [
            {
              name: t('chat:composer.filterImages'),
              extensions: ['jpg', 'jpeg', 'png'],
            },
          ],
        })

        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files: File[] = []

          for (const path of paths) {
            try {
              // Grant asset access (paths outside the static scope), then build the URL
              const fileUrl = await toAssetUrl(path)
              const response = await fetch(fileUrl)
              if (!response.ok) {
                throw new Error(`Failed to fetch file: ${response.statusText}`)
              }
              const blob = await response.blob()
              const fileName =
                path.split(/[\\/]/).filter(Boolean).pop() || 'image'
              files.push(
                new File([blob], fileName, { type: pickedImageMime(fileName) })
              )
            } catch (error) {
              console.error('Failed to read file:', error)
              toast.error(t('chat:composer.readFileFailed'), {
                description:
                  error instanceof Error ? error.message : String(error),
              })
            }
          }

          if (files.length > 0) {
            await processImageFiles(files)
          }
        }
      } catch (error) {
        console.error('Failed to open file dialog:', error)
      }

      focusComposer()
    } else {
      // Fallback to input click for web
      fileInputRef.current?.click()
    }
  }, [serviceHub, processImageFiles, t, focusComposer])

  return {
    fileInputRef,
    processImageFiles,
    attachFiles,
    handleFileChange,
    openImagePicker,
    visionPrompt,
    handleVisionChoice,
  }
}
