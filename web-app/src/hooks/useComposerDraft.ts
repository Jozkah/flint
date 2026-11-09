import { usePrompt } from '@/hooks/usePrompt'
import { useCallback, useEffect, useRef } from 'react'

/**
 * The composer's draft: the main one, or a split pane's own (`draftScope`),
 * kept per chat, with its history and the restore of a refused send. Lifted
 * out of ChatInput.tsx unchanged, in the same hook order.
 */
export function useComposerDraft({
  draftScope,
  scopeKey,
  threadIdProp,
  routeThreadId,
}: {
  draftScope: string | undefined
  scopeKey: string | undefined
  threadIdProp: string | undefined
  routeThreadId: string | undefined
}) {
  // The main draft, or this composer's own when it has a scope (the second
  // pane of a split conversation), so typing in one never edits the other.
  const mainPrompt = usePrompt((state) => state.prompt)
  const scopedPrompt = usePrompt((state) =>
    draftScope ? (state.scoped?.[draftScope]?.prompt ?? '') : ''
  )
  const prompt = draftScope ? scopedPrompt : mainPrompt
  // The draft as of the last render, for a refused send's restore (below).
  const latestPromptRef = useRef(prompt)
  latestPromptRef.current = prompt
  // Text put back after a refused send. The draft store may be shared with
  // other composers (the unscoped one is), so it is taken out again when this
  // composer goes away or moves to another session, if still untouched.
  const restoredDraftRef = useRef<string | null>(null)
  const setMainPrompt = usePrompt((state) => state.setPrompt)
  const setScopedPrompt = usePrompt((state) => state.setScopedPrompt)
  const setPrompt = useCallback(
    (value: string) =>
      draftScope ? setScopedPrompt(draftScope, value) : setMainPrompt(value),
    [draftScope, setScopedPrompt, setMainPrompt]
  )
  const addToHistory = usePrompt((state) => state.addToHistory)
  useEffect(
    () => () => {
      const restored = restoredDraftRef.current
      restoredDraftRef.current = null
      if (restored !== null && latestPromptRef.current === restored) {
        setPrompt('')
      }
    },
    [scopeKey, draftScope, setPrompt]
  )
  const navigateMainHistory = usePrompt((state) => state.navigateHistory)
  const navigateScopedHistory = usePrompt(
    (state) => state.navigateScopedHistory
  )
  const navigateHistory = useCallback(
    (direction: 'up' | 'down') =>
      draftScope
        ? navigateScopedHistory(draftScope, direction)
        : navigateMainHistory(direction),
    [draftScope, navigateScopedHistory, navigateMainHistory]
  )
  // The main composer's draft is per chat: leaving a chat keeps its unsent
  // text for it, and the chat shown gets back its own (or nothing).
  const draftKey =
    scopeKey ??
    threadIdProp ??
    // Home and New Chat keep the last chat id in the store: key them apart.
    (routeThreadId && /\/threads\//.test(window.location.pathname)
      ? routeThreadId
      : '__new__')
  const switchDraft = usePrompt((state) => state.switchDraft)
  useEffect(() => {
    if (!draftScope) switchDraft?.(draftKey)
  }, [draftKey, draftScope, switchDraft])

  return {
    prompt,
    latestPromptRef,
    restoredDraftRef,
    setPrompt,
    addToHistory,
    navigateHistory,
  }
}
