// The interface settings store's transcript, reply and sound settings.

import type { StoreApi } from 'zustand'
import { DEFAULT_TRANSCRIPT_VIEW, isTranscriptView } from '@/lib/transcriptView'
import { sanitizeCompletionSound, sanitizeVolume } from './values'
import type { InterfaceSettingsState } from './types'

/** How transcripts and replies read, the completion sound and the composer rail. */
export const chatDisplaySlice = (
  set: StoreApi<InterfaceSettingsState>['setState']
): Pick<
  InterfaceSettingsState,
  | 'resetChatDisplay'
  | 'setShowTokenSpeed'
  | 'setRenderUserMarkdown'
  | 'setColoredUserBubble'
  | 'setRenderHtmlArtifacts'
  | 'setWrapCodeLines'
  | 'setShowInlineCitations'
  | 'setAutoGenerateTitle'
  | 'setTranscriptView'
  | 'setCompletionSound'
  | 'setCompletionSoundVolume'
  | 'setShowComposerRailButtons'
> => ({
  resetChatDisplay: () => {
    set({
      showTokenSpeed: true,
      renderUserMarkdown: false,
      renderHtmlArtifacts: false,
      wrapCodeLines: false,
      showInlineCitations: true,
      autoGenerateTitle: true,
      transcriptView: DEFAULT_TRANSCRIPT_VIEW,
      showComposerRailButtons: false,
    })
  },

  setShowTokenSpeed: (show) => {
    set({ showTokenSpeed: show })
  },

  setRenderUserMarkdown: (render) => {
    set({ renderUserMarkdown: render })
  },
  setColoredUserBubble: (colored) => {
    set({ coloredUserBubble: colored })
  },

  setRenderHtmlArtifacts: (render) => {
    set({ renderHtmlArtifacts: render })
  },

  setWrapCodeLines: (wrap) => {
    set({ wrapCodeLines: wrap })
  },

  setShowInlineCitations: (show) => {
    set({ showInlineCitations: show })
  },

  setAutoGenerateTitle: (auto) => {
    set({ autoGenerateTitle: auto })
  },

  setTranscriptView: (view) => {
    if (!isTranscriptView(view)) return
    set({ transcriptView: view })
  },
  setCompletionSound: (mode) => {
    set({ completionSound: sanitizeCompletionSound(mode) })
  },

  setCompletionSoundVolume: (volume) => {
    set({ completionSoundVolume: sanitizeVolume(volume) })
  },

  setShowComposerRailButtons: (show) => {
    set({ showComposerRailButtons: show })
  },
})
