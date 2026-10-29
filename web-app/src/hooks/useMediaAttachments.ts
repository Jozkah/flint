import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { toAssetUrl } from '@/lib/assetPath'
import { isPlatformTauri } from '@/lib/platform/utils'
import {
  VIDEO_EXTS,
  mediaBatchErrors,
  prepareAudioFiles,
  prepareVideoFiles,
  splitNewByContent,
  videoMimeForExt,
  type MediaBatch,
} from '@/lib/attachmentIntake'
import type { Attachment } from '@/types/attachment'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Kind = 'audio' | 'video'

/** What differs between attaching audio and attaching video. */
const KIND = {
  audio: {
    prepare: prepareAudioFiles,
    extensions: ['wav', 'mp3'],
    mimeFor: (ext?: string) => (ext === 'mp3' ? 'audio/mpeg' : 'audio/wav'),
    filterKey: 'chat:composer.filterAudio',
    dupKey: 'chat:composer.dupAudio',
    readFailedKey: 'chat:composer.readAudioFailed',
  },
  video: {
    prepare: prepareVideoFiles,
    extensions: VIDEO_EXTS,
    mimeFor: videoMimeForExt,
    filterKey: 'chat:composer.filterVideo',
    dupKey: 'chat:composer.dupVideo',
    readFailedKey: 'chat:composer.readVideoFailed',
  },
} satisfies Record<
  Kind,
  {
    prepare: (files: File[]) => Promise<MediaBatch>
    extensions: string[]
    mimeFor: (ext?: string) => string
    filterKey: string
    dupKey: string
    readFailedKey: string
  }
>

export type MediaAttachmentKind = {
  /** The hidden `<input type=file>` used outside the desktop app. */
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Read files and add the new ones to the draft's attachments. */
  process: (files: File[]) => Promise<void>
  /** `onChange` of the hidden input. */
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  /** The native file dialog in the desktop app, else the hidden input. */
  openPicker: () => Promise<void>
}

function useMediaKind(
  kind: Kind,
  {
    attachmentsKey,
    setMessage,
    focusComposer,
  }: {
    attachmentsKey: string
    setMessage: (message: string) => void
    focusComposer: () => void
  }
): MediaAttachmentKind {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const setAttachmentsForThread = useChatAttachments((s) => s.setAttachments)
  const inputRef = useRef<HTMLInputElement>(null)
  const spec = KIND[kind]

  const process = useCallback(
    async (files: File[]) => {
      const batch = await spec.prepare(files)
      const current = useChatAttachments
        .getState()
        .getAttachments(attachmentsKey)
      const { fresh, duplicates } = await splitNewByContent(
        batch.prepared,
        current,
        kind
      )

      if (fresh.length > 0) {
        setAttachmentsForThread(attachmentsKey, (prev: Attachment[]) => [
          ...prev,
          ...fresh,
        ])
      }

      if (duplicates.length > 0) {
        toast.warning(t(spec.dupKey), {
          description: t('sweep:chat.alreadyInList', {
            count: duplicates.length,
            names: duplicates.join(', '),
          }),
        })
      }
      const errors = mediaBatchErrors(kind, batch, t)
      if (errors.length > 0) {
        setMessage(errors.join(' | '))
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [attachmentsKey, setAttachmentsForThread, t, kind, spec, setMessage]
  )

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      void process(Array.from(files))
      if (inputRef.current) inputRef.current.value = ''
    }
    focusComposer()
  }

  const openPicker = useCallback(async () => {
    if (!isPlatformTauri()) {
      inputRef.current?.click()
      return
    }
    try {
      const selected = await serviceHub.dialog().open({
        multiple: true,
        filters: [{ name: t(spec.filterKey), extensions: spec.extensions }],
      })
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected]
        const files: File[] = []
        for (const path of paths) {
          try {
            const response = await fetch(await toAssetUrl(path))
            if (!response.ok) throw new Error(response.statusText)
            const blob = await response.blob()
            const fileName = path.split(/[\\/]/).filter(Boolean).pop() || kind
            const ext = fileName.toLowerCase().split('.').pop()
            files.push(new File([blob], fileName, { type: spec.mimeFor(ext) }))
          } catch (error) {
            console.error(`Failed to read ${kind} file:`, error)
            toast.error(t(spec.readFailedKey), {
              description:
                error instanceof Error ? error.message : String(error),
            })
          }
        }
        if (files.length > 0) await process(files)
      }
    } catch (error) {
      console.error(`Failed to open ${kind} dialog:`, error)
    }
    focusComposer()
  }, [serviceHub, process, t, kind, spec, focusComposer])

  return { inputRef, process, onInputChange, openPicker }
}

/**
 * Attaching audio and video to the draft: reading the files, skipping ones
 * already attached (by name), reporting the rest, and the pickers that feed
 * them in.
 */
export function useMediaAttachments(options: {
  attachmentsKey: string
  setMessage: (message: string) => void
  focusComposer: () => void
}): { audio: MediaAttachmentKind; video: MediaAttachmentKind } {
  return {
    audio: useMediaKind('audio', options),
    video: useMediaKind('video', options),
  }
}
