import type { SessionStatus } from '@/lib/remote/protocol'
import { TopThread } from '../shell/TopBar'
import { Composer } from '../shell/Composer'
import { accessLabel, modeLabel } from '../shell/labels'
import { I } from '../ui/icons'
import { Empty, Loading } from '../ui/bits'
import { compact } from '../ui/format'
import { AssistantHeader, Prose, ToolTimeline, UserBubble } from '../ui/messages'
import { ApprovalCard } from '../ui/ApprovalCard'
import { act, openDrawer, openSheet } from '../state/app'
import { useRpc } from '../state/rpc'
import { useStickToBottom } from '../ui/hooks'

const STATUS: Record<SessionStatus, string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  idle: 'Cowork',
  paused: 'Paused',
  done: 'Completed',
}

export default function Cowork({ id }: { id: string }) {
  const detail = useRpc('cowork.get', { id })
  const msgs = useRpc('thread.messages', { id, kind: 'cowork', limit: 100 })
  const status = useRpc('status', {})
  const approvals = useRpc('approvals.list', {}, (status.data?.approvalsWaiting ?? 0) > 0)
  const d = detail.data
  const messages = msgs.data?.messages ?? []
  const mine = (approvals.data?.approvals ?? []).filter((a) => a.threadId === id)
  const ref = useStickToBottom(messages.length + mine.length)
  const running = d?.status === 'running' || d?.status === 'waiting'
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')?.id
  const todos = d?.todos ?? []
  const done = todos.filter((t) => t.status === 'completed').length
  const mode = modeLabel(d?.mode ?? 'ask')
  const access = accessLabel(d?.access ?? 'review-only')
  const stepCount = messages.reduce((n, m) => n + (m.tools?.length ?? 0), 0)
  const models = useRpc('models.list', {})
  const settings = useRpc('settings.get', {})
  const modelName = d?.model
    ? (models.data?.models.find((m) => m.id === d.model?.id && m.provider === d.model.provider)?.name ?? d.model.id)
    : 'Model'

  return (
    <>
      <TopThread
        crumb={
          <>
            {d && d.status !== 'idle' && d.status !== 'done' && (
              <span className={`sd ${d.status === 'waiting' ? 'wait' : 'run'}`} style={{ width: 6, height: 6 }} />
            )}
            {d ? (d.status === 'idle' ? 'Cowork' : `${STATUS[d.status]} · Cowork`) : 'Cowork'}
          </>
        }
        title={d?.title || 'Cowork session'}
        menu={() => openSheet('sessmenu', { id, title: d?.title })}
      />
      <div className="subbar">
        {d?.group && (
          <button type="button" className="chip" onClick={() => openSheet('workspace', { folder: d.folder, group: d.group })}>
            <I n="folder" size={13} />
            {d.group}
            <I n="chev" size={11} />
          </button>
        )}
        <button type="button" className="chip" onClick={() => openDrawer('right', 'timeline')}>
          <I n="activity" size={13} />
          Activity {stepCount > 0 ? stepCount : ''}
        </button>
        <button type="button" className="chip" onClick={() => openDrawer('right', 'changes')}>
          <I n="plus" size={12} />
          Changes
        </button>
      </div>
      <div className="scroll" ref={ref} data-testid="cowork-scroll">
        {(detail.loading || msgs.loading) && !msgs.data && <Loading />}
        {detail.error && !d && <Empty>{detail.error.message}</Empty>}
        {msgs.data && messages.length === 0 && <Empty>Nothing in this session yet.</Empty>}
        {msgs.data && msgs.data.start > 0 && <div className="compact">{msgs.data.start} earlier messages on the computer</div>}
        {messages.map((m) => {
          if (m.role === 'user') return <UserBubble key={m.id} text={m.text} />
          if (m.role !== 'assistant') return null
          const isLast = m.id === lastAssistant
          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {m.text && (
                <div className="msg">
                  <AssistantHeader model={d?.model?.id} at={m.createdAt} />
                  <Prose text={m.text} />
                </div>
              )}
              {m.tools && m.tools.length > 0 && <ToolTimeline steps={m.tools} />}
              {isLast && mine.map((a) => <ApprovalCard key={a.requestId} a={a} />)}
            </div>
          )
        })}
        {!lastAssistant && mine.map((a) => <ApprovalCard key={a.requestId} a={a} />)}
      </div>
      {todos.length > 0 && (
        <div className="plan" role="button" data-tool-kind="todo" onClick={() => openDrawer('right', 'progress')}>
          <I n="todo" size={14} style={{ color: 'var(--tk)' }} />
          <span>Progress</span>
          <span className="pb">
            <i style={{ width: `${(done / todos.length) * 100}%` }} />
          </span>
          <span className="muted">
            {done} of {todos.length} done
          </span>
        </div>
      )}
      <Composer
        placeholder="Ask me anything..."
        extra={
          <>
            <button type="button" className="mp" onClick={() => openSheet('cwoptions', { id })}>
              <I n="opts" size={15} />
              <span>Options</span>
            </button>
            {settings.data?.webSearch.enabled && (
              <span className="optnote">
                <I n="globe" size={12} />
                Web search
              </span>
            )}
          </>
        }
        tokens={d?.usage ? compact(d.usage.inputTokens + d.usage.outputTokens) : undefined}
        running={running}
        stopFor={{ kind: 'cowork', id }}
        onSend={async (text) => (await act('cowork.send', { id, text })) !== undefined}
      />
      <div className="runrow">
        <button type="button" className={`rq${d?.mode === 'auto' ? ' amber' : ''}`} onClick={() => openSheet('mode', { id, value: d?.mode })}>
          <span>{mode?.short}</span>
        </button>
        <button type="button" className={`rq${d?.access === 'edit-folder' ? ' amber' : ''}`} onClick={() => openSheet('access', { id, value: d?.access })}>
          <span>{access?.short}</span>
        </button>
        <button type="button" className="rq" onClick={() => openSheet('profile', { id })}>
          <I n="wand" size={13} />
          Auto
        </button>
        <button type="button" className="rq rm2" onClick={() => openSheet('model', { for: 'cowork', id })}>
          <span>{modelName}</span>
        </button>
      </div>
    </>
  )
}
