import { useEffect, useState } from 'react'
import type { RemoteMessage } from '@/lib/remote/protocol'
import { TopThread } from '../shell/TopBar'
import { Composer } from '../shell/Composer'
import { I } from '../ui/icons'
import { Empty, Loading } from '../ui/bits'
import { AssistantMessage, UserBubble } from '../ui/messages'
import { PendingBubble, QueueBar, StreamingMessage } from '../ui/live'
import { act, app, client, openSheet, sendMessage, toast, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { useSessions } from '../state/sessions'
import { pendingFor, prunePending, useLive } from '../state/live'
import { useFollow, useStickToBottom } from '../ui/hooks'

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
  const composer = useApp((s) => s.composer)
  const stream = useLive((s) => s.streams[id])
  const pendingAll = useLive((s) => s.pending)
  const [older, setOlder] = useState<RemoteMessage[]>([])
  const [olderStart, setOlderStart] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
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
  // Loading old history must not snap the user back to the newest message.
  const ref = useStickToBottom(messages.length + pending.length + (streamShown?.text.length ?? 0))
  const running = session?.status === 'running' || Boolean(stream && !stream.done)
  const earlier = olderStart ?? data?.start ?? 0

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
        {data && allMessages.length === 0 && !pending.length && !streamShown && <Empty>No messages yet.</Empty>}
        {allMessages.map((m) =>
          m.role === 'user' ? (
            <UserBubble key={m.id} text={m.text} />
          ) : m.role === 'assistant' ? (
            <AssistantMessage
              key={m.id}
              m={m}
              actions={
                <div className="macts">
                  <button
                    type="button"
                    className="ib"
                    aria-label="Copy"
                    onClick={() =>
                      void navigator.clipboard?.writeText(m.text).then(
                        () => toast('Copied'),
                        () => toast('Copy failed')
                      )
                    }
                  >
                    <I n="copy" />
                  </button>
                  <button type="button" className="ib" aria-label="Message actions" onClick={() => openSheet('msgmenu', { id: m.id })}>
                    <I n="more" />
                  </button>
                </div>
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
        extra={
          <>
            <button type="button" className="ib" onClick={() => openSheet('tools')} aria-label="Tools">
              <I n="wrench" />
            </button>
            <button
              type="button"
              className={`ib${composer.web ? ' on' : ''}`}
              aria-label="Web Search"
              aria-pressed={composer.web}
              onClick={() => {
                const web = !app.get().composer.web
                app.set((s) => ({ composer: { ...s.composer, web } }))
                void act('settings.set', { key: 'webSearch', value: web })
              }}
            >
              <I n="globe" />
            </button>
            <button type="button" className="ib" onClick={() => openSheet('reason', { for: 'chat', id })} aria-label="Reasoning settings">
              <I n="bulb" />
            </button>
          </>
        }
        running={running}
        stopFor={{ kind: 'chat', id }}
        allowWhileRunning
        onSend={async (text) => (await sendMessage('chat.send', { id, text })) !== undefined}
      />
    </>
  )
}
