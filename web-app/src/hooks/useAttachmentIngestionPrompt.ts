import { Attachment } from '@/types/attachment'
import { create } from 'zustand'

type AttachmentSummary = Pick<Attachment, 'name' | 'size'>

type AttachmentIngestionState = {
  isModalOpen: boolean
  currentAttachment: AttachmentSummary | null
  currentIndex: number
  totalCount: number
  sizeThreshold: number
  resolver: ((choice: 'inline' | 'embeddings' | undefined) => void) | null
  showPrompt: (
    attachment: AttachmentSummary,
    sizeThreshold: number,
    currentIndex: number,
    totalCount: number
  ) => Promise<'inline' | 'embeddings' | undefined>
  choose: (choice: 'inline' | 'embeddings') => void
  cancel: () => void
}

type Choice = 'inline' | 'embeddings' | undefined

type PendingPrompt = {
  attachment: AttachmentSummary
  sizeThreshold: number
  currentIndex: number
  totalCount: number
  resolve: (choice: Choice) => void
}

// Prompts that arrived while another one was on screen. Asked in arrival order
// so a second caller no longer overwrites (and strands) the first one's
// resolver (janhq/jan#9337).
const waiting: PendingPrompt[] = []

const showNext = (
  set: (partial: Partial<AttachmentIngestionState>) => void
) => {
  const next = waiting.shift()
  if (!next) {
    set({ isModalOpen: false, currentAttachment: null, resolver: null })
    return
  }
  set({
    isModalOpen: true,
    currentAttachment: next.attachment,
    currentIndex: next.currentIndex,
    totalCount: next.totalCount,
    sizeThreshold: next.sizeThreshold,
    resolver: next.resolve,
  })
}

export const useAttachmentIngestionPrompt = create<AttachmentIngestionState>()(
  (set, get) => ({
    isModalOpen: false,
    currentAttachment: null,
    currentIndex: 0,
    totalCount: 0,
    sizeThreshold: 0,
    resolver: null,
    showPrompt: async (attachment, sizeThreshold, currentIndex, totalCount) => {
      return new Promise<Choice>((resolve) => {
        if (get().resolver) {
          waiting.push({
            attachment,
            sizeThreshold,
            currentIndex,
            totalCount,
            resolve,
          })
          return
        }
        set({
          isModalOpen: true,
          currentAttachment: attachment,
          currentIndex,
          totalCount,
          sizeThreshold,
          resolver: resolve,
        })
      })
    },
    choose: (choice) => {
      const { resolver } = get()
      resolver?.(choice)
      showNext(set)
    },
    cancel: () => {
      const { resolver } = get()
      resolver?.(undefined)
      showNext(set)
    },
  })
)
