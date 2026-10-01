// Conversation pieces: user bubbles, Flint's replies, and the tool timeline
// in the desktop's style (coloured dot on the rail, "Used read" in the kind's
// colour, a tinted origin chip, the argument in mono).
import { Fragment, useState, type ReactNode } from 'react'
import type { RemoteMessage, RemoteToolStep } from '@/lib/remote/protocol'
import { FlintMark } from './bits'
import { clock, toolLabel } from './format'
import { I } from './icons'
import { ASSISTANT_ICON } from './assistants'
import { ReplyRow } from './reply'

/** Inline `code` and @mentions inside a line of text. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|@[A-Za-z][\w.-]*)/g).map((part, i) =>
    part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : part.startsWith('@') && part.length > 1 ? (
      <span key={i} className="ment">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  )
}

/** Plain text with light structure: paragraphs, bullet lists, fenced code.
 * Everything is rendered as text nodes, never as HTML. */
export function Prose({ text, tail }: { text: string; tail?: ReactNode }) {
  const blocks: ReactNode[] = []
  const chunks = text.split(/(```[\s\S]*?(?:```|$))/g)
  chunks.forEach((chunk, ci) => {
    if (chunk.startsWith('```')) {
      const body = chunk.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
      blocks.push(
        <pre key={`c${ci}`} className="cmd" style={{ margin: '0 0 8px' }}>
          {body.replace(/\n$/, '')}
        </pre>
      )
      return
    }
    chunk
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((p, pi) => {
        const lines = p.split('\n')
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
          blocks.push(
            <ul key={`${ci}-${pi}`}>
              {lines.map((l, li) => (
                <li key={li}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>
              ))}
            </ul>
          )
        } else {
          blocks.push(
            <p key={`${ci}-${pi}`}>
              {lines.map((l, li) => (
                <Fragment key={li}>
                  {li > 0 && <br />}
                  {inline(l)}
                </Fragment>
              ))}
            </p>
          )
        }
      })
  })
  if (tail) {
    const last = blocks[blocks.length - 1]
    // The caret sits at the end of the last line, as on the desktop.
    if (last && typeof last === 'object' && 'type' in last && last.type === 'p') {
      blocks[blocks.length - 1] = (
        <p key={last.key ?? 'tail'}>
          {(last.props as { children: ReactNode }).children}
          {tail}
        </p>
      )
    } else blocks.push(<p key="tail">{tail}</p>)
  }
  return <div className="prose">{blocks}</div>
}

export function UserBubble({ text }: { text: string }) {
  return <div className="ub msg">{text}</div>
}

/** `‹ 2/3 ›` on a message that has other versions; absent on a plain one. */
export function VersionNav({
  versions,
  onStep,
}: {
  versions?: { index: number; count: number }
  onStep: (dir: -1 | 1) => void
}) {
  if (!versions || versions.count < 2) return null
  const { index, count } = versions
  return (
    <div className="vnav" role="group" aria-label="Message versions" data-testid="version-nav">
      <button
        type="button"
        className="ib"
        aria-label={`Previous version (showing ${index} of ${count})`}
        disabled={index <= 1}
        onClick={() => onStep(-1)}
      >
        <I n="chev" style={{ transform: 'rotate(90deg)' }} />
      </button>
      <span role="status" aria-live="polite" aria-label={`Version ${index} of ${count}`}>
        {index}/{count}
      </span>
      <button
        type="button"
        className="ib"
        aria-label={`Next version (showing ${index} of ${count})`}
        disabled={index >= count}
        onClick={() => onStep(1)}
      >
        <I n="chev" style={{ transform: 'rotate(-90deg)' }} />
      </button>
    </div>
  )
}

export function ToolStep({ step }: { step: RemoteToolStep }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`step${open ? ' open' : ''}`} data-tool-kind={step.kind} data-testid="tool-step">
      <button type="button" className="th" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {step.status === 'running' && <I n="loader" spin style={{ color: 'var(--tk)' }} />}
        <span className="tn">{toolLabel(step)}</span>
        {step.origin && <span className="org">{step.origin}</span>}
        <span className="arg">{step.arg ?? ''}</span>
        <I n="chev" className="chev" />
      </button>
      {open && (
        <div className="tb">
          <div className="tsec">
            <div className="h">Parameters</div>
            <dl className="kv2">
              <dt>tool</dt>
              <dd>
                <code>{step.name}</code>
              </dd>
              {step.arg && (
                <>
                  <dt>argument</dt>
                  <dd>
                    <code>{step.arg}</code>
                  </dd>
                </>
              )}
            </dl>
          </div>
        </div>
      )}
    </div>
  )
}

/** A run's tool calls under a "N steps" toggle, the latest few shown. */
export function ToolTimeline({ steps, after }: { steps: RemoteToolStep[]; after?: ReactNode }) {
  const [open, setOpen] = useState(true)
  if (!steps.length && !after) return null
  return (
    <>
      {steps.length > 0 && (
        <button type="button" className="stepcount" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <I n="chev" size={13} style={open ? undefined : { transform: 'rotate(-90deg)' }} />
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
        </button>
      )}
      {open && (
        <div className="tl">
          {steps.map((s) => (
            <ToolStep key={s.id} step={s} />
          ))}
          {after}
        </div>
      )}
    </>
  )
}

export function AssistantHeader({ name = 'Flint', model, at }: { name?: string; model?: string; at?: number }) {
  return (
    <div className="ah">
      {ASSISTANT_ICON[name] ? (
        <span className="fm" style={{ color: ASSISTANT_ICON[name][1] }} data-assistant={name}>
          <I n={ASSISTANT_ICON[name][0]} size={14} />
        </span>
      ) : (
        <span className="fm">
          <FlintMark />
        </span>
      )}
      <b>{name}</b>
      {model && (
        <>
          ·<span>{model}</span>
        </>
      )}
      {at ? (
        <>
          ·<span>{clock(at)}</span>
        </>
      ) : null}
    </div>
  )
}

export function AssistantMessage({
  m,
  model,
  actions,
  timeline = true,
}: {
  m: RemoteMessage
  model?: string
  actions?: ReactNode
  timeline?: boolean
}) {
  return (
    <div className="msg">
      <AssistantHeader name={m.meta?.assistant ?? 'Flint'} model={model ?? m.meta?.model} at={m.createdAt} />
      {timeline && m.tools && m.tools.length > 0 && <ToolTimeline steps={m.tools} />}
      {m.text && <Prose text={m.text} />}
      {actions}
      <ReplyRow meta={m.meta} />
    </div>
  )
}
