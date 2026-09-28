// What the phone shows ahead of the stored record: a reply being written
// (with the caret), messages on their way, answered approvals, the queue.
import { useState } from 'react'
import type { QueuedItem } from '@/lib/remote/protocol'
import { AssistantHeader, Prose, ToolTimeline, UserBubble } from './messages'
import { I } from './icons'
import { retrySend } from '../state/app'
import { dropPending, type LiveStream, type PendingSend, type Resolution } from '../state/live'

export function StreamingMessage({ s, model, timeline = true }: { s: LiveStream; model?: string; timeline?: boolean }) {
  const [thinking, setThinking] = useState(false)
  return (
    <div className="msg" data-testid="streaming-message" aria-live="polite" aria-busy={!s.done}>
      <AssistantHeader name={s.author ?? 'Flint'} model={model} />
      {s.reasoning && (
        <button type="button" className="stepcount" onClick={() => setThinking((t) => !t)} aria-expanded={thinking}>
          <I n="chev" size={13} style={thinking ? undefined : { transform: 'rotate(-90deg)' }} />
          {s.done || s.text ? 'Thought' : 'Thinking…'}
        </button>
      )}
      {thinking && s.reasoning && <div className="prose muted" style={{ fontSize: 12.5 }}>{s.reasoning}</div>}
      {timeline && s.tools.length > 0 && <ToolTimeline steps={s.tools} />}
      <Prose text={s.text} tail={s.done ? undefined : <span className="caret" data-testid="caret" aria-hidden />} />
    </div>
  )
}

const STATUS_WORD: Record<PendingSend['status'], string> = {
  sending: 'Sending…',
  sent: 'Sent',
  queued: 'Queued · sends when the current run ends',
  steered: 'Steering · goes to the run at its next step',
  failed: 'Not sent',
}

export function PendingBubble({ p }: { p: PendingSend }) {
  return (
    <div style={{ display: 'contents' }} data-testid="pending-send" data-status={p.status}>
      <UserBubble text={p.text} />
      <div className="pendst">
        {p.status === 'sending' && <I n="loader" size={11} spin />}
        {p.status === 'failed' && <I n="alert" size={11} style={{ color: 'var(--destructive)' }} />}
        <span>{STATUS_WORD[p.status]}</span>
        {p.status === 'failed' && (
          <>
            <button type="button" className="btn sm ghost" onClick={() => void retrySend(p)}>
              Retry
            </button>
            <button type="button" className="btn sm ghost" onClick={() => dropPending(p.clientId)}>
              Discard
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function ResolvedLine({ r }: { r: Resolution }) {
  return (
    <div className="resolved" data-testid="approval-resolved">
      <I n={r.by === 'phone' ? 'check' : 'monitor'} size={14} style={{ color: r.by === 'phone' ? 'var(--success)' : undefined }} />
      {r.label}
    </div>
  )
}

/** Queued and steering messages, as the desktop's queue above the composer. */
export function QueueBar({ items }: { items: QueuedItem[] }) {
  if (!items.length) return null
  return (
    <div className="queue" data-testid="queue">
      {items.map((m) => (
        <div key={m.id} className="qm">
          <I n={m.steer ? 'steer' : 'clock'} />
          <span className="x">{m.from ? `Message from ${m.from}: ${m.text}` : m.text}</span>
          <small>{m.held ? 'Held · send it on the computer' : m.steer ? 'Steering' : 'Queued'}</small>
        </div>
      ))}
    </div>
  )
}
