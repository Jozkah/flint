import { useEffect } from 'react'
import { TopThread } from '../shell/TopBar'
import { Composer } from '../shell/Composer'
import { I } from '../ui/icons'
import { Empty, Loading } from '../ui/bits'
import { AssistantMessage, UserBubble } from '../ui/messages'
import { PendingBubble, QueueBar, StreamingMessage } from '../ui/live'
import { act, app, notYet, openSheet, sendMessage, toast, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { useSessions } from '../state/sessions'
import { pendingFor, prunePending, useLive } from '../state/live'
import { useFollow, useStickToBottom } from '../ui/hooks'

export default function Chat({ id }: { id: string }) {
  const { sessions } = useSessions()
  const session = sessions.find((s) => s.id === id)
  const { data, loading, error } = useRpc('thread.messages', { id, kind: 'chat', limit: 100 })
  const queue = useRpc('thread.queue', { id })
  const composer = useApp((s) => s.composer)
  const stream = useLive((s) => s.streams[id])
  const pendingAll = useLive((s) => s.pending)
  const messages = data?.messages ?? []
  const pending = pendingFor(pendingAll, id, messages)
  useFollow('chat', id)
  useEffect(() => {
    if (data) prunePending(id, data.messages)
  }, [id, data])
  const streamShown = stream && !messages.some((m) => m.id === stream.messageId) ? stream : null
  const ref = useStickToBottom(messages.length + pending.length + (streamShown?.text.length ?? 0))
  const running = session?.status === 'running' || Boolean(stream && !stream.done)
  const earlier = data ? data.start : 0

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
        {earlier > 0 && <div className="compact">{earlier} earlier messages on the computer</div>}
        {loading && !data && <Loading />}
        {error && !data && <Empty>{error.message}</Empty>}
        {data && messages.length === 0 && !pending.length && !streamShown && <Empty>No messages yet.</Empty>}
        {messages.map((m) =>
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
                  <button type="button" className="ib" aria-label="Regenerate response" onClick={() => notYet('Regenerating')}>
                    <I n="refresh" />
                  </button>
                  <button type="button" className="ib" aria-label="Message actions" onClick={() => openSheet('msgmenu', { id: m.id })}>
                    <I n="more" />
                  </button>
                </div>
              }
            />
          ) : null
        )}
        {pending.map((p) => (
          <PendingBubble key={p.clientId} p={p} />
        ))}
        {streamShown && <StreamingMessage s={streamShown} />}
      </div>
      <QueueBar items={queue.data?.items ?? []} />
      <Composer
        placeholder="Ask me anything..."
        model={composer.model}
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
                // The desktop composer's toggle is one setting for every chat.
                void act('settings.set', { key: 'webSearch', value: web })
              }}
            >
              <I n="globe" />
            </button>
            <button type="button" className="ib" onClick={() => openSheet('reason', { for: 'chat', id })} aria-label="Reasoning">
              <I n="bulb" />
            </button>
          </>
        }
        running={running}
        stopFor={{ kind: 'chat', id }}
        // While a run is going the desktop queues what is typed; so does this.
        allowWhileRunning
        onSend={async (text) => (await sendMessage('chat.send', { id, text })) !== undefined}
      />
    </>
  )
}
