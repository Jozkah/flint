import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/**
 * How much of a Cowork session's activity the timeline shows.
 *
 * Presentation only. Nothing here deletes an event: tool activity stays in the
 * session, in exports and in search whatever this says, and turning the option
 * off brings it straight back without a reload.
 */
type CoworkDisplayState = {
  /**
   * "Hide completed tool activity". Off by default -- seeing what the agent
   * did is the point of the timeline.
   *
   * Only cleanly successful activity is ever hidden. Running, awaiting
   * permission, failed, refused, cancelled and stale items are always shown.
   */
  hideCompletedTools: boolean
  setHideCompletedTools: (hide: boolean) => void
  /**
   * What happens once a Review only run finishes with files in its sandbox:
   * left there (the default), offered in the "Apply all" confirmation, or
   * applied straight away when nothing would be overwritten. A conflict is
   * always asked about.
   */
  /**
   * The per-turn "What the model received" row and its token count. Off by
   * default; the snapshot is recorded either way and stays reachable from
   * the session's details and timeline.
   */
  showPromptSnapshot: boolean
  setShowPromptSnapshot: (show: boolean) => void
  reviewOnlyFinish: ReviewOnlyFinish
  setReviewOnlyFinish: (value: ReviewOnlyFinish) => void
  /** The "N files ready for review" bar over the composer. On by default. */
  showFilesReadyBar: boolean
  setShowFilesReadyBar: (show: boolean) => void
  /**
   * Bars hidden with their ×, per session, as the change signature they were
   * hidden at. New changes differ from it and bring the bar back. Not saved.
   */
  hiddenReadyBars: Record<string, string>
  hideReadyBar: (sessionId: string, signature: string) => void
}

export type ReviewOnlyFinish = 'keep' | 'ask' | 'auto'

/** What identifies one set of changes for the bar's ×. */
export const readyBarSignature = (
  fileCount: number,
  additions: number,
  deletions: number
) => `${fileCount}:${additions}:${deletions}`

export const useCoworkDisplay = create<CoworkDisplayState>()(
  persist(
    (set) => ({
      hideCompletedTools: false,
      setHideCompletedTools: (hideCompletedTools) => set({ hideCompletedTools }),
      showPromptSnapshot: false,
      setShowPromptSnapshot: (showPromptSnapshot) => set({ showPromptSnapshot }),
      reviewOnlyFinish: 'keep',
      setReviewOnlyFinish: (reviewOnlyFinish) => set({ reviewOnlyFinish }),
      showFilesReadyBar: true,
      setShowFilesReadyBar: (showFilesReadyBar) => set({ showFilesReadyBar }),
      hiddenReadyBars: {},
      hideReadyBar: (sessionId, signature) =>
        set((state) => ({
          hiddenReadyBars: { ...state.hiddenReadyBars, [sessionId]: signature },
        })),
    }),
    {
      name: localStorageKey.coworkDisplay,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (state) => ({
        hideCompletedTools: state.hideCompletedTools,
        showPromptSnapshot: state.showPromptSnapshot,
        reviewOnlyFinish: state.reviewOnlyFinish,
        showFilesReadyBar: state.showFilesReadyBar,
      }),
    }
  )
)

/**
 * Whether the per-turn "What the model received" row shows. An independent
 * Cowork setting (off by default); the transcript view does not affect it.
 */
export const useShowPromptSnapshot = () =>
  useCoworkDisplay((s) => s.showPromptSnapshot)
