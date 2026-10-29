import {
  useBrowserToolMirror,
  useBrowserToolMirrorListening,
} from '@/hooks/useBrowserToolMirror'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import { useCoworkLayout } from '@/hooks/cowork/useCoworkLayout'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useMessageQueue } from '@/stores/message-queue-store'
import { drainIdleSession } from '@/lib/mailboxDelivery'
import { sendQueuedViaComposer } from '@/lib/remote/queuedSend'
import { addSnapshotSink, type PromptSnapshotRef } from '@/lib/providerFetch'
import { useCoworkView, type CoworkRail } from '@/hooks/useCoworkView'
import { recordEvents } from '@/lib/eventLog'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import type { CoworkSession } from '@/hooks/useCoworkSessions'
import type { RefObject } from 'react'
import type { QueuedMessageSender } from '@/stores/message-queue-store'
import type { CoworkAttachmentInput } from '@/lib/coworkAttachments'
import type { Dispatch } from 'react'
import type { SetStateAction } from 'react'
import type { CodeOpenOptions } from '@/lib/codeOpen'

export type CoworkViewStateArgs = {
  running: boolean
  session: CoworkSession | null
  runRequestRef: RefObject<(text: string | null, from?: QueuedMessageSender | undefined, hidden?: boolean | undefined, attachmentInput?: CoworkAttachmentInput | undefined, onRefused?: (() => void) | undefined) => Promise<void>>
  transcriptRef: RefObject<HTMLDivElement | null>
  lastSnapshotRef: RefObject<Record<string, PromptSnapshotRef>>
  setLastPreviewPath: Dispatch<SetStateAction<string | undefined>>
  setLastPreviewRoot: Dispatch<SetStateAction<string | undefined>>
  workspacePath: string | null
  setRail: (next: CoworkRail) => void
  attachFolder: (given?: string) => Promise<void>
  openToolPath: (path: string, options?: CodeOpenOptions) => void
  rail: { kind: "preview"; path?: string; root?: string; } | { kind: "diff"; focusPath?: string; } | { kind: "code"; } | { kind: "tasks"; } | { kind: "timeline"; } | { kind: "browser"; } | { kind: "background"; } | null
}

export function useCoworkViewState({
  running,
  session,
  runRequestRef,
  transcriptRef,
  lastSnapshotRef,
  setLastPreviewPath,
  setLastPreviewRoot,
  workspacePath,
  setRail,
  attachFolder,
  openToolPath,
  rail,
}: CoworkViewStateArgs) {

  /**
   * Queued messages belong to the session they were typed in. When the session
   * in view is idle and has one waiting it goes -- after its own run finishes,
   * or when the user returns to a session whose run finished while they were
   * elsewhere. Never dispatched into another session.
   */
  /**
   * Pending input survives a restart (janhq/jan#8864). Every change to a Cowork
   * session's queue is mirrored into the persisted session, and what the
   * session recorded comes back held -- for the user to send or discard, never
   * sent on its own. Restoring skips what is already queued, so this is
   * harmless while the app is running.
   */
  useEffect(
    () =>
      useMessageQueue.subscribe((state, prev) => {
        const store = useCoworkSessions.getState()
        for (const s of store.sessions) {
          const now = state.queues[s.id] ?? []
          if (now !== (prev.queues[s.id] ?? [])) store.setPendingInput(s.id, now)
        }
      }),
    []
  )
  const sessionsWithPending = useCoworkSessions((s) =>
    s.sessions
      .filter((x) => (x.pendingInput?.length ?? 0) > 0)
      .map((x) => x.id)
      .join(',')
  )
  useEffect(() => {
    for (const s of useCoworkSessions.getState().sessions) {
      if (s.pendingInput?.length) {
        useMessageQueue.getState().restoreHeld(s.id, s.pendingInput)
      }
    }
  }, [sessionsWithPending])

  // Mail released for an idle session in view (Automatic wake-ups) becomes
  // ready without `running` or the session changing, so the count is watched.
  const readyCount = useMessageQueue((s) =>
    !running && session?.id
      ? s.getQueue(session.id).filter((m) => !m.held).length
      : 0
  )
  const idleDrainRef = useRef(false)
  useEffect(() => {
    if (running || !session?.id || idleDrainRef.current) return
    // Held input waits for the user; only what is ready goes. Mail is claimed
    // first, so a reply a tool already consumed is not sent again.
    idleDrainRef.current = true
    // The message is sent only into the session it was drained from; see
    // drainIdleSession.
    const sid = session.id
    void drainIdleSession(sid, (text, from, attachments) => {
      // A phone's message queued with attachments goes through the
      // session's composer entry, as a phone's send to an idle session does.
      if (attachments) {
        void sendQueuedViaComposer('cowork', sid, text, attachments).then(
          (sent) => {
            if (!sent) void runRequestRef.current(text, from)
          }
        )
        return
      }
      void runRequestRef.current(text, from)
    })
      .then(() => {
        idleDrainRef.current = false
      })
      .catch(() => {
        idleDrainRef.current = false
      })
  }, [running, session?.id, readyCount, runRequestRef])

  /**
   * Where the transcript was scrolled to, kept across a trip to Settings.
   *
   * The scroll node is the one `StickToBottom` owns inside the `role="log"`
   * container; it is found rather than held by ref because that element is the
   * library's, not this route's. It is looked for inside this page's own
   * transcript only: in split view each pane has one.
   */
  const scrollNode = useCallback((): HTMLElement | null => {
    const log = transcriptRef.current?.querySelector('[role="log"]')
    if (!log) return null
    return (
      (log.querySelector(':scope > *') as HTMLElement | null) ??
      (log as HTMLElement)
    )
  }, [transcriptRef])

  useEffect(() => {
    const sid = session?.id
    if (!sid) return
    const remembered = useCoworkView.getState().scrollBySession[sid]
    if (remembered != null) {
      // After paint: the transcript has to exist before it can be scrolled.
      requestAnimationFrame(() => {
        const node = scrollNode()
        if (node) node.scrollTop = remembered
      })
    }
  }, [session?.id, scrollNode])
  // Remembered in a layout cleanup: it runs while the transcript is still
  // attached, on a session switch and when the page unmounts (leaving for
  // Settings, closing a pane). A passive cleanup ran after the ref was
  // detached, so an unmount remembered nothing.
  useLayoutEffect(() => {
    const sid = session?.id
    if (!sid) return
    return () => {
      const node = scrollNode()
      if (node) {
        useCoworkView.getState().rememberScroll(sid, node.scrollTop)
      }
    }
  }, [session?.id, scrollNode])

  // Snapshots are taken in the transport, which has nowhere to return them to
  // -- the AI SDK owns the call. It hands them here instead, and they land on
  // the turn whose reply that request produced.
  useEffect(() => {
    return addSnapshotSink((sessionId, ref) => {
      // Kept for the step that follows: the accounting for a dispatch is only
      // known once its reply lands, and by then the sink has moved on.
      lastSnapshotRef.current[sessionId] = ref
      // AH-032: the record links this request to the exact payload it sent,
      // the same way the agent loop does, so a finished run can be replayed
      // from the record rather than from a reconstruction of it. Recorded
      // under the run that is dispatching, never the session in view.
      const running = useCoworkRun.getState().runs[sessionId]?.runId
      if (running) {
        void recordEvents([
          {
            id: `dispatch:${ref.invocation || ref.id}`,
            session: sessionId,
            run: running,
            invocation: ref.invocation ?? '',
            kind: 'message.completed',
            payload: {
              phase: 'dispatched',
              snapshotId: ref.id,
              hash: ref.hash,
              redactions: ref.redactions,
            },
          },
        ])
      }
      // Beside the turns, not on them: the run rebuilds its live turn array as
      // steps complete, so a reference written onto a turn at dispatch time is
      // gone before it can render.
      useCoworkRun.getState().recordPromptSnapshot(sessionId, ref)
    })
  }, [lastSnapshotRef])

  // A run outlives this component, so unmounting must not stop it.
  useEffect(() => () => useCoworkRun.getState().clearPendingPreview(), [])

  // The artifacts library selects a session, parks the path here and navigates.
  // Consumed once, so returning to Cowork later does not reopen it.
  const pendingPreview = useCoworkRun((s) => s.pendingPreview)
  useEffect(() => {
    if (!pendingPreview || !session?.id) return
    if (pendingPreview.sessionId !== session.id) return
    setLastPreviewPath(pendingPreview.path)
    setLastPreviewRoot(workspacePath ?? undefined)
    setRail({ kind: 'preview', path: pendingPreview.path, root: workspacePath ?? undefined })
    useCoworkRun.getState().clearPendingPreview()
  }, [pendingPreview, session?.id, setRail, workspacePath, setLastPreviewPath, setLastPreviewRoot])

  // The file-activity view parks a request the same way, for a path it wants
  // shown but cannot open itself. Consumed once.
  // An entry point outside Cowork asked for a folder. The picker lives here
  // because this is where a session can be bound to what it returns.
  const attachFolderRequested = useCoworkRun((s) => s.attachFolderRequested)
  useEffect(() => {
    if (!attachFolderRequested) return
    // Cleared before the picker opens, not after: the dialog is awaited, and a
    // request left standing would reopen it on the next render.
    useCoworkRun.getState().clearAttachFolderRequest()
    void attachFolder()
  }, [attachFolderRequested, attachFolder])

  const pendingCodeOpen = useCoworkRun((s) => s.pendingCodeOpen)
  useEffect(() => {
    if (!pendingCodeOpen || !session?.id) return
    if (pendingCodeOpen.sessionId !== session.id) return
    if (pendingCodeOpen.as === 'diff') {
      setRail({ kind: 'diff' })
    } else {
      setRail({ kind: 'code' })
      openToolPath(pendingCodeOpen.path)
    }
    useCoworkRun.getState().clearPendingCodeOpen()
  }, [pendingCodeOpen, session?.id, openToolPath, setRail])

  // Nothing to show once the session changes: every panel describes the session
  // it was opened from.
  //
  // Only a real switch closes the rail. Opening the Code or Activity rail with
  // no session yet *creates* one (ensureCurrentSession), which moved
  // `session?.id` from null to a fresh id in the same commit — and this effect
  // then closed the rail the click had just opened, so the first click did
  // nothing and only a second one worked.
  const lastSessionId = useRef(session?.id)
  useEffect(() => {
    const previous = lastSessionId.current
    lastSessionId.current = session?.id
    if (previous != null && previous !== session?.id) setRail(null)
  }, [session?.id, setRail])

  const {
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
  } = useCoworkLayout({ scrollNode, setRail })
  // The agent's browser (the `browser` tool) gets its own tab in the output
  // panel: it opens when the agent opens a page and goes when its browser closes.
  useBrowserToolMirrorListening()
  const agentBrowserOpen = useBrowserToolMirror((s) =>
    session?.id ? Boolean(s.byId[session.id]) : false
  )
  const sawAgentBrowser = useRef(false)
  useEffect(() => {
    if (agentBrowserOpen && !sawAgentBrowser.current) {
      sawAgentBrowser.current = true
      setRail({ kind: 'browser' })
    } else if (!agentBrowserOpen && sawAgentBrowser.current) {
      sawAgentBrowser.current = false
      if (rail?.kind === 'browser') setRail(null)
    }
    // Only the browser appearing or going away moves the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentBrowserOpen])
  return {
    revealOutput,
    phone,
    narrow,
    view,
    closeRail,
    agentBrowserOpen,
    compactRun,
    paneChrome,
    showView,
    compactViews,
    openRail,
    phoneStrip,
  }
}
