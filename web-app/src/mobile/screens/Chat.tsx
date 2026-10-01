import { Fragment, useEffect, useState } from 'react'
import type { RemoteMessage } from '@/lib/remote/protocol'
import { TopThread } from '../shell/TopBar'
import { Composer } from '../shell/Composer'
import { I } from '../ui/icons'
import { Empty, Loading } from '../ui/bits'
import { AssistantMessage, UserBubble, VersionNav } from '../ui/messages'
import { PendingBubble, QueueBar, StreamingMessage } from '../ui/live'
import { client, openSheet, sendMessage, toast } from '../state/app'
import { forkFrom, stepVersion } from '../state/controls'
import { effortStops, stopLabel } from '../ui/effort'
import { useRpc } from '../state/rpc'
import { useSessions } from '../state/sessions'
import { pendingFor, prunePending, useLive } from '../state/live'
import { useFollow, useStickToBottom } from '../ui/hooks'
import { copyToClipboard } from '@/lib/clipboard'

const PAGE = 100

function AuxiliaryMessage({ m }: { m: RemoteMessage }) {
  return (
    <div className="msg frame" data-message-role={m.role} style={{ padding: '10px 12px', marginBottom: 12 }}>
      <div className="lbl" style={{ marginBottom: 5 }}>
        {m.role === 'system' ? 'System' : 'Tool'}
      </div>
      <div className="prose" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {m.text || (m.role === 'tool' ? 'Tool event' : 'System message')}
      </div>
    </div>
  )
}

export default function Chat({ id }: { id: string }) {
  const { sessions } = useSessions()
  const session = sessions.find((s) => s.id === id)
  const { data, loading, error } = useRpc('thread.messages', { id, kind: 'chat', limit: PAGE })
  const queue = useRpc('thread.queue', { id })
  const details = useRpc('chat.details', { id })
  const det = details.data
  const stream = useLive((s) => s.streams[id])
  const pendingAll = useLive((s) => s.pending)
  const [older, setOlder] = useState<RemoteMessage[]>([])
  const [olderStart, setOlderStart] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // The window is the newest PAGE messages, so a new message pushes the oldest
  // one out of it. Indexes are stable (history only appends), so carry what the
  // previous window held below the new start into `older`; otherwise it is lost.
  const [seen, setSeen] = useState<{ id: string; start: number; messages: RemoteMessage[] } | null>(null)
  if (data && seen?.id === id && seen.messages !== data.messages && data.start > seen.start) {
    const dropped = seen.messages.slice(0, data.start - seen.start)
    setOlder((current) => {
      const have = new Set(current.map((m) => m.id))
      return [...current, ...dropped.filter((m) => !have.has(m.id))]
    })
  }
  if (data && (seen?.id !== id || seen.messages !== data.messages)) {
    setSeen({ id, start: data.start, messages: data.messages })
  }
  const messages = data?.messages ?? []
  const allMessages = [...older, ...messages.filter((m) => !older.some((o) => o.id === m.id))]
  const pending = pendingFor(pendingAll, id, allMessages)
  useFollow('chat', id)

  useEffect(() => {
    setOlder([])
    setOlderStart(null)
  }, [id])

  useEffect(() => {
    if (data) {
      prunePending(id, data.messages)
      if (olderStart === null) setOlderStart(data.start)
    }
  }, [id, data, olderStart])

  const streamShown = stream && !allMessages.some((m) => m.id === stream.messageId) ? stream : null
  const ref = useStickToBottom(messages.length + pending.length + (streamShown?.text.length ?? 0))
  const running = session?.status === 'running' || Boolean(stream && !stream.done)
  const earlier = olderStart ?? data?.start ?? 0

  // A switched version changes the path, so the pages already loaded above the
  // newest window may belong to the version just left: start from the window.
  const stepOf = (messageId: string) => async (dir: -1 | 1) => {
    if (await stepVersion(id, messageId, dir)) {
      setOlder([])
      setOlderStart(null)
      setSeen(null)
    }
  }

  const loadEarlier = async () => {
    if (!earlier || loadingOlder) return
    const el = ref.current
    const previousHeight = el?.scrollHeight ?? 0
    setLoadingOlder(true)
    try {
      const page = await client().rpc('thread.messages', { id, kind: 'chat', before: earlier, limit: PAGE })
      setOlder((current) => {
        const seen = new Set(current.map((m) => m.id))
        return [...page.messages.filter((m) => !seen.has(m.id)), ...current]
      })
      setOlderStart(page.start)
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - previousHeight
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load earlier messages')
    } finally {
      setLoadingOlder(false)
    }
  }

  return (
    <>
      <TopThread
        crumb={
          <>
            {running && <span className="sd run" style={{ width: 6, height: 6 }} />}
            Chats{session?.group ? ` · ${session.group}` : ''}
          </>
        }
        title={session?.title || 'Chat'}
        menu={() => openSheet('threadmenu', { id, title: session?.title })}
      />
      <div className="scroll" ref={ref} data-testid="chat-scroll">
        {earlier > 0 && (
          <button type="button" className="btn ghost" style={{ alignSelf: 'center', margin: '4px 0 16px' }} disabled={loadingOlder} onClick={() => void loadEarlier()}>
            {loadingOlder ? 'Loading earlier messages…' : `Load ${Math.min(PAGE, earlier)} earlier message${Math.min(PAGE, earlier) === 1 ? '' : 's'}`}
          </button>
        )}
        {loading && !data && <Loading />}
        {error && !data && <Empty>{error.message}</Empty>}
        {det?.modelMissing && (
          <div className="notice" data-testid="model-gone">
            <b>A model is no longer available</b>
            <span>{det.model?.name ?? 'This chat’s model'} was removed from the computer.</span>
            <button type="button" className="btn sm" onClick={() => openSheet('modelgone', { id, name: det.model?.name })}>Choose a model</button>
          </div>
        )}
        {data && allMessages.length === 0 && !pending.length && !streamShown && <Empty>No messages yet.</Empty>}
        {allMessages.map((m) =>
          m.role === 'user' ? (
            <Fragment key={m.id}>
              <UserBubble text={m.text} />
              <VersionNav versions={m.versions} onStep={(d) => void stepOf(m.id)(d)} />
            </Fragment>
          ) : m.role === 'assistant' ? (
            <AssistantMessage
              key={m.id}
              m={m}
              actions={
                <>
                <VersionNav versions={m.versions} onStep={(d) => void stepOf(m.id)(d)} />
                <div className="macts">
                  <button
                    type="button"
                    className="ib"
                    aria-label="Copy"
                    onClick={() =>
                      void copyToClipboard(m.text).then((ok) =>
                        toast(ok ? 'Copied' : 'Copy failed')
                      )
                    }
                  >
                    <I n="copy" />
                  </button>
                  <button type="button" className="ib" aria-label="Fork chat from here" onClick={() => void forkFrom(id, m.id)}>
                    <I n="fork" />
                  </button>
                  <button type="button" className="ib" aria-label="Message actions" onClick={() => openSheet('msgmenu', { id, messageId: m.id, text: m.text })}>
                    <I n="more" />
                  </button>
                </div>
                </>
              }
            />
          ) : (
            <AuxiliaryMessage key={m.id} m={m} />
          )
        )}
        {pending.map((p) => (
          <PendingBubble key={p.clientId} p={p} />
        ))}
        {streamShown && <StreamingMessage s={streamShown} />}
      </div>
      <QueueBar items={queue.data?.items ?? []} />
      <Composer
        placeholder="Ask me anything..."
        model={undefined}
        modelFor="chat"
        plus={{ for: 'chat', id }}
        ctx={{ pct: det?.context?.windowTokens ? (det.context.usedTokens / det.context.windowTokens) * 100 : 0, for: 'chat', id }}
        running={running}
        stopFor={{ kind: 'chat', id }}
        allowWhileRunning
        onSend={async (text) => (await sendMessage('chat.send', { id, text })) !== undefined}
      />
      <div className="runrow">
        {det?.effort && (
          <button type="button" className="rq" data-testid="effort-button" onClick={() => openSheet('effort', { id })}>
            {stopLabel(effortStops(det.effort).shown)}
          </button>
        )}
        <button type="button" className="rq" onClick={() => openSheet('profile', { id })}>
          <I n="wand" size={13} />
          {det?.assistant.auto ? 'Auto' : (det?.assistant.name ?? 'Auto')}
        </button>
        <button type="button" className="rq rm2" onClick={() => openSheet('model', { for: 'chat', id })}>
          <span>{det?.model?.name ?? 'Model'}</span>
        </button>
      </div>
    </>
  )
}
