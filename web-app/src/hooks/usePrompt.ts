import { create } from 'zustand'

const MAX_HISTORY_SIZE = 100

/** A composer's own draft and its place in the shared prompt history. */
export type ScopedPrompt = {
  prompt: string
  historyIndex: number
  draftPrompt: string
}

const EMPTY_SCOPE: ScopedPrompt = { prompt: '', historyIndex: -1, draftPrompt: '' }

type PromptStoreState = {
  prompt: string
  setPrompt: (value: string) => void
  resetPrompt: () => void

  // Prompt history for up/down arrow navigation
  promptHistory: string[]
  historyIndex: number
  draftPrompt: string
  addToHistory: (value: string) => void
  navigateHistory: (direction: 'up' | 'down') => void
  resetHistoryNavigation: () => void

  /**
   * Drafts for composers that must not share the main one -- the second pane
   * of a split conversation. The unscoped fields above stay the main
   * composer's, so every existing reader keeps working. History is shared:
   * it is what the user sent, wherever they sent it from.
   */
  scoped: Record<string, ScopedPrompt>
  setScopedPrompt: (scope: string, value: string) => void
  navigateScopedHistory: (scope: string, direction: 'up' | 'down') => void
}

/**
 * One step through the history from a draft's current position. Returns the
 * next position, or null when the step goes nowhere.
 */
function stepHistory(
  history: string[],
  current: ScopedPrompt,
  direction: 'up' | 'down'
): ScopedPrompt | null {
  if (history.length === 0) return null
  if (direction === 'up') {
    const nextIndex = current.historyIndex + 1
    if (nextIndex >= history.length) return null
    return {
      historyIndex: nextIndex,
      // Save current input as draft when first entering history
      draftPrompt:
        current.historyIndex === -1 ? current.prompt : current.draftPrompt,
      prompt: history[nextIndex],
    }
  }
  if (current.historyIndex <= -1) return null
  const nextIndex = current.historyIndex - 1
  return {
    ...current,
    historyIndex: nextIndex,
    prompt: nextIndex === -1 ? current.draftPrompt : history[nextIndex],
  }
}

export const usePrompt = create<PromptStoreState>((set, get) => ({
  prompt: '',
  setPrompt: (value) => {
    set({ prompt: value })
    // Reset history navigation when user types manually
    if (get().historyIndex !== -1) {
      set({ historyIndex: -1 })
    }
  },
  resetPrompt: () => set({ prompt: '' }),

  // History state
  promptHistory: [],
  historyIndex: -1,
  draftPrompt: '',

  addToHistory: (value) => {
    const trimmed = value.trim()
    if (!trimmed) return
    const { promptHistory } = get()
    // Avoid consecutive duplicates
    if (promptHistory.length > 0 && promptHistory[0] === trimmed) return
    set({
      promptHistory: [trimmed, ...promptHistory].slice(0, MAX_HISTORY_SIZE),
      historyIndex: -1,
    })
  },

  navigateHistory: (direction) => {
    const { promptHistory, historyIndex, prompt, draftPrompt } = get()
    if (promptHistory.length === 0) return

    if (direction === 'up') {
      const nextIndex = historyIndex + 1
      if (nextIndex >= promptHistory.length) return
      // Save current input as draft when first entering history
      const newDraft = historyIndex === -1 ? prompt : draftPrompt
      set({
        historyIndex: nextIndex,
        draftPrompt: newDraft,
        prompt: promptHistory[nextIndex],
      })
    } else {
      // direction === 'down'
      if (historyIndex <= -1) return
      const nextIndex = historyIndex - 1
      if (nextIndex === -1) {
        // Restore draft
        set({
          historyIndex: -1,
          prompt: draftPrompt,
        })
      } else {
        set({
          historyIndex: nextIndex,
          prompt: promptHistory[nextIndex],
        })
      }
    }
  },

  resetHistoryNavigation: () => set({ historyIndex: -1, draftPrompt: '' }),

  scoped: {},
  setScopedPrompt: (scope, value) =>
    set((state) => {
      const current = state.scoped[scope] ?? EMPTY_SCOPE
      return {
        scoped: {
          ...state.scoped,
          // Typing leaves history navigation, as in the main composer.
          [scope]: { ...current, prompt: value, historyIndex: -1 },
        },
      }
    }),
  navigateScopedHistory: (scope, direction) =>
    set((state) => {
      const next = stepHistory(
        state.promptHistory,
        state.scoped[scope] ?? EMPTY_SCOPE,
        direction
      )
      return next ? { scoped: { ...state.scoped, [scope]: next } } : state
    }),
}))
