import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTextOverflow } from '@/hooks/useTextOverflow'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { readDetailsOpen, writeDetailsOpen } from '@/lib/chat/threadHelpers'

/**
 * The Details inspector ("What Flint is using") beside a conversation: open
 * or closed (remembered), which half a narrow pane shows, and the title that
 * fades in a split. Lifted out of ThreadConversation.tsx unchanged.
 */
export function useThreadDetails(isSplit: boolean) {
  // The Details inspector ("What Flint is using"). On a narrow pane it takes the
  // whole width and a switch moves between it and the conversation; the
  // conversation stays mounted, so its draft and scroll survive.
  // Open beside the conversation on a wide window, as the design shows it;
  // the last choice is remembered. A narrow window starts on the
  // conversation, since there the inspector takes the whole width.
  const [detailsOpen, setDetailsOpen] = useState(() => readDetailsOpen(isSplit))
  const [narrowView, setNarrowView] = useState<'conversation' | 'details'>(
    'conversation'
  )
  const detailsPanelId = useId()
  // A phone's page header has room for one button (see controlsWith).
  const isPhone = useMediaQuery('(max-width: 639px)')
  // The split pane's title fades only when it is too long to fit.
  const titleRef = useRef<HTMLHeadingElement>(null)
  useTextOverflow(titleRef)
  // Splitting halves the width; the inspector gives its room to the panes.
  useEffect(() => {
    if (isSplit) {
      setDetailsOpen(false)
      setNarrowView('conversation')
    }
  }, [isSplit])
  const toggleDetails = useCallback(() => {
    const next = !detailsOpen
    setDetailsOpen(next)
    setNarrowView(next ? 'details' : 'conversation')
    writeDetailsOpen(next)
  }, [detailsOpen])
  const closeDetails = useCallback(() => {
    setDetailsOpen(false)
    setNarrowView('conversation')
    writeDetailsOpen(false)
  }, [])

  return {
    detailsOpen,
    narrowView,
    setNarrowView,
    detailsPanelId,
    isPhone,
    titleRef,
    toggleDetails,
    closeDetails,
  }
}
