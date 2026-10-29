import { useCallback, useEffect, useRef, useState } from 'react'

type Focusable = {
  focus: () => void
  element?: HTMLElement | null
}

/**
 * Where keyboard focus goes for a chat composer, and whether it is there.
 *
 * - `isFocused` follows focus in and out of the composer's element.
 * - On mount and on every thread change the composer takes focus, unless
 *   the person is typing in another field (a parameter input, a dialog).
 * - When a reply finishes (`chatStatus` back to 'ready') it takes focus only
 *   if nothing else holds it, so a sampler or menu is not dismissed.
 *
 * Every timer is cleared when its effect re-runs or the composer unmounts.
 */
export function useComposerFocus({
  composerRef,
  takeFocus,
  threadId,
  chatStatus,
}: {
  composerRef: React.RefObject<Focusable | null>
  takeFocus: boolean
  threadId?: string
  chatStatus?: string
}) {
  const isComposerElement = useCallback(
    (el: Element | null) =>
      !!el && !!composerRef.current?.element?.contains(el),
    [composerRef]
  )
  const focusComposer = useCallback(() => {
    composerRef.current?.focus()
  }, [composerRef])
  const focusComposerUnlessTyping = useCallback(() => {
    const active = document.activeElement
    const typing =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    if (typing && !isComposerElement(active)) return
    focusComposer()
  }, [focusComposer, isComposerElement])

  const [isFocused, setIsFocused] = useState(false)
  useEffect(() => {
    const handleFocusIn = () => {
      if (isComposerElement(document.activeElement)) setIsFocused(true)
    }
    const handleFocusOut = () => {
      if (!isComposerElement(document.activeElement)) setIsFocused(false)
    }
    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)
    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [isComposerElement])

  // `takeFocus` is read when the thread changes, not watched: turning it on
  // later must not pull focus by itself.
  const takeFocusRef = useRef(takeFocus)
  takeFocusRef.current = takeFocus
  useEffect(() => {
    if (!takeFocusRef.current) return
    const timer = setTimeout(focusComposerUnlessTyping, 0)
    return () => clearTimeout(timer)
  }, [threadId, focusComposerUnlessTyping])

  useEffect(() => {
    if (!takeFocus || chatStatus !== 'ready') return
    const timer = setTimeout(() => {
      const active = document.activeElement
      if (!active || active === document.body || isComposerElement(active)) {
        focusComposer()
      }
    }, 10)
    return () => clearTimeout(timer)
  }, [chatStatus, takeFocus, focusComposer, isComposerElement])

  return { isFocused, isComposerElement, focusComposer, focusComposerUnlessTyping }
}
