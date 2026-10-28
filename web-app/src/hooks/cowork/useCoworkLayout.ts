import { usePaneChrome, usePaneWidth } from '@/hooks/useCoworkPane'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { type CoworkRail } from '@/hooks/useCoworkView'

export type CoworkPhoneView = 'content' | 'output' | 'details'

/**
 * How the Cowork page lays itself out: wide windows dock the output panel, a
 * narrower one makes it a drawer, and a phone shows one view at a time. In a
 * split-view pane the pane's width decides, not the window's. Moved out of
 * the page unchanged.
 */
export function useCoworkLayout({
  scrollNode,
  setRail,
}: {
  scrollNode: () => HTMLElement | null
  setRail: (next: CoworkRail | null) => void
}) {
  // Layout. Wide windows dock the output panel beside the conversation; below
  // 1100px it becomes a drawer over the conversation's right edge; below 768px
  // Cowork shows one view at a time -- the conversation, the output, or the
  // session details -- chosen from the context bar. The conversation stays
  // mounted while hidden, so the composer keeps its draft, and its scroll
  // position is put back on return.
  // In a split-view pane the pane's width decides, not the window's.
  const paneWidth = usePaneWidth()
  // In a split pane this page draws the pane's one header row: title, its
  // own controls and the pane's, instead of the shell header's context bar,
  // the phone view row and the conversation frame's title row.
  const paneChrome = usePaneChrome()
  // Narrow panes switch views by icon; wider ones spell the views out.
  const compactViews = paneWidth != null && paneWidth < 520
  const windowNarrow = useMediaQuery('(max-width: 1099px)')
  const windowPhone = useMediaQuery('(max-width: 767px)')
  const narrow = paneWidth != null ? paneWidth < 1100 : windowNarrow
  const phone = paneWidth != null ? paneWidth < 768 : windowPhone
  // Up to 900px of pane (or window) the run's folder, access and mode fold
  // into one Run chip under the composer.
  const windowCompact = useMediaQuery('(max-width: 900px)')
  const compactRun = paneWidth != null ? paneWidth <= 900 : windowCompact
  // A phone (640px and below): the status strip names only its most urgent item.
  const windowPhoneStrip = useMediaQuery('(max-width: 640px)')
  const phoneStrip = paneWidth != null ? paneWidth <= 640 : windowPhoneStrip
  const [phoneView, setPhoneView] = useState<CoworkPhoneView>('content')
  const view: CoworkPhoneView = phone ? phoneView : 'content'
  const transcriptScroll = useRef<number | null>(null)
  const showView = useCallback(
    (next: CoworkPhoneView) => {
      if (phoneView === 'content' && next !== 'content') {
        const node = scrollNode()
        transcriptScroll.current = node ? node.scrollTop : null
      }
      setPhoneView(next)
    },
    [phoneView, scrollNode]
  )
  useEffect(() => {
    if (view !== 'content' || transcriptScroll.current == null) return
    const top = transcriptScroll.current
    transcriptScroll.current = null
    requestAnimationFrame(() => {
      const node = scrollNode()
      if (node) node.scrollTop = top
    })
  }, [view, scrollNode])

  // On a phone, an explicit request to see output also shows the output view.
  // Automatic opens (an artifact finishing) change the tab but not the view.
  const revealOutput = useCallback(() => {
    if (phone) showView('output')
  }, [phone, showView])
  const openRail = useCallback(
    (next: CoworkRail) => {
      setRail(next)
      revealOutput()
    },
    [setRail, revealOutput]
  )
  const closeRail = useCallback(() => {
    setRail(null)
    if (phone) showView('content')
  }, [setRail, phone, showView])

  return {
    paneChrome,
    compactViews,
    narrow,
    phone,
    compactRun,
    phoneStrip,
    view,
    showView,
    revealOutput,
    openRail,
    closeRail,
  }
}
