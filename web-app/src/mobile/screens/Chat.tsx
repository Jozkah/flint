import { Fragment, useEffect, useState } from 'react'
import type { RemoteMessage } from '@/lib/remote/protocol'
import { TopThread } from '../shell/TopBar'
import { Composer } from '../shell/Composer'
import { I } from '../ui/icons'
import { Empty, Loading } from '../ui/bits'
import { AssistantMessage, UserBubble, VersionNav } from '../ui/messages'
import { PendingBubble, QueueBar, ResolvedLine, StreamingMessage } from '../ui/live'
import { ApprovalCard } from '../ui/ApprovalCard'
import { PromptCard } from '../ui/PromptCard'
import { client, openSheet, sendMessage, toast } from '../state/app'
import { forkFrom, stepVersion } from '../state/controls'
import { effortStops, stopLabel } from '../ui/effort'
import { useRpc } from '../state/rpc'
import { useSessions } from '../state/sessions'
import { pendingFor, prunePending, useLive } from '../state/live'
import { useFollow, useStickToBottom } from '../ui/hooks'
import { copyToClipboard } from '@/lib/clipboard'
import { t } from '../i18n'

const PAGE = 100

function AuxiliaryMessage({ m }: { m: RemoteMessage }) {
  return (
    <div className="msg frame" data-message-role={m.role} style={{ padding: '10px 12px', marginBottom: 12 }}>
      <div className="lbl" style={{ marginBottom: 5 }}>
        {m.role === 'system' ? t('chat.system') : t('chat.tool')}
      </div>
      <div className="prose" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {m.text || (m.role === 'tool' ? t('chat.toolEvent') : t('chat.systemMessage'))}
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
  // A chat's tool calls ask too (MCP tools, web search): answer them here.
  const status = useRpc('status', {})
  const approvals = useRpc('approvals.list', {}, (status.data?.approvalsWaiting ?? 0) > 0)
  const mine = (approvals.data?.approvals ?? []).filter((a) => a.threadId === id)
  const promptList = useRpc('prompts.list', {}, (status.data?.promptsWaiting ?? 0) > 0)
  const prompts = (promptList.data?.prompts ?? []).filter((p) => p.threadId === id)
  const resolvedAll = useLive((s) => s.resolved)
  const resolved = Object.entries(resolvedAll).filter(
    ([rid, r]) => r.threadId === id && !mine.some((a) => a.requestId === rid) && !prompts.some((p) => p.id === rid)
  )
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
  const ref = useStickToBottom(messages.length + pending.length + mine.length + (streamShown?.text.length ?? 0))
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
      toast(e instanceof Error ? e.message : t('chat.loadEarlierFailed'))
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
            {t('chat.crumb')}{session?.group ? ` · ${session.group}` : ''}
          </>
        }
        title={session?.title || t('chat.untitled')}
        menu={() => openSheet('threadmenu', { id, title: session?.title })}
      />
      <div className="scroll" ref={ref} data-testid="chat-scroll">
        {earlier > 0 && (
          <button type="button" className="btn ghost" style={{ alignSelf: 'center', margin: '4px 0 16px' }} disabled={loadingOlder} onClick={() => void loadEarlier()}>
            {loadingOlder ? t('chat.loadingEarlier') : t('chat.loadEarlier', { count: Math.min(PAGE, earlier) })}
          </button>
        )}
        {loading && !data && <Loading />}
        {error && !data && <Empty>{error.message}</Empty>}
        {det?.modelMissing && (
          <div className="notice" data-testid="model-gone">
            <b>{t('chat.modelGoneTitle')}</b>
            <span>{t('chat.modelGoneBody', { name: det.model?.name ?? t('chat.thisModel') })}</span>
            <button type="button" className="btn sm" onClick={() => openSheet('modelgone', { id, name: det.model?.name })}>{t('chat.chooseModel')}</button>
          </div>
        )}
        {data && allMessages.length === 0 && !pending.length && !streamShown && <Empty>{t('chat.noMessages')}</Empty>}
        {allMessages.map((m) =>
          m.role === 'user' ? (
            <Fragment key={m.id}>
              <UserBubble text={m.text} attachments={m.attachments} />
              <div className="macts user">
                <button type="button" className="ib" aria-label={t('chat.messageActions')} onClick={() => openSheet('msgmenu', { id, messageId: m.id, text: m.text, role: 'user' })}>
                  <I n="more" />
                </button>
              </div>
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
                    aria-label={t('common.copy')}
                    onClick={() =>
                      void copyToClipboard(m.text).then((ok) =>
                        toast(ok ? t('common.copied') : t('common.copyFailed'))
                      )
                    }
                  >
                    <I n="copy" />
                  </button>
                  <button type="button" className="ib" aria-label={t('chat.forkFromHere')} onClick={() => void forkFrom(id, m.id)}>
                    <I n="fork" />
                  </button>
                  <button type="button" className="ib" aria-label={t('chat.messageActions')} onClick={() => openSheet('msgmenu', { id, messageId: m.id, text: m.text })}>
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
        {mine.map((a) => (
          <ApprovalCard key={a.requestId} a={a} />
        ))}
        {prompts.map((p) => (
          <PromptCard key={p.id} p={p} />
        ))}
        {resolved.map(([rid, r]) => (
          <ResolvedLine key={rid} r={r} />
        ))}
      </div>
      <QueueBar items={queue.data?.items ?? []} />
      <Composer
        placeholder={t('chat.placeholder')}
        model={undefined}
        modelFor="chat"
        plus={{ for: 'chat', id }}
        ctx={{ pct: det?.context?.windowTokens ? (det.context.usedTokens / det.context.windowTokens) * 100 : 0, for: 'chat', id }}
        running={running}
        stopFor={{ kind: 'chat', id }}
        allowWhileRunning
        onSend={async (text) => (await sendMessage('chat.send', { id, text })) !== undefined}
        onSteer={async (text) => (await sendMessage('chat.send', { id, text, steer: true })) !== undefined}
      />
      <div className="runrow">
        {det?.effort && (
          <button type="button" className="rq" data-testid="effort-button" onClick={() => openSheet('effort', { id })}>
            {stopLabel(effortStops(det.effort).shown)}
          </button>
        )}
        <button type="button" className="rq" onClick={() => openSheet('profile', { id })}>
          <I n="wand" size={13} />
          {det?.assistant.auto ? t('chat.auto') : (det?.assistant.name ?? t('chat.auto'))}
        </button>
        <button type="button" className="rq rm2" onClick={() => openSheet('model', { for: 'chat', id })}>
          <span>{det?.model?.name ?? t('chat.model')}</span>
        </button>
      </div>
    </>
  )
}
