import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Avatar } from '../ui/bits'
import { I } from '../ui/icons'
import { DictateButton, insertInto } from '../ui/dictate'
import { openSheet } from '../state/app'
import type { ComposerModel } from '../state/app'
import { attachKey, attachments, removeAttachment, type PhoneAttachment } from '../state/attachments'

const EMPTY: PhoneAttachment[] = []

/** The files waiting in a composer, each with remove. */
export function AttachmentChips({ k }: { k: string }) {
  const list = attachments.use((s) => s.by[k] ?? EMPTY)
  if (!list.length) return null
  return (
    <div className="attchips" data-testid="attach-chips">
      {list.map((a) => (
        <span key={a.localId} className={`attchip ${a.status}`} title={a.error ?? a.name}>
          {a.preview ? <img src={a.preview} alt="" /> : <I n={a.desk ? 'monitor' : 'file'} />}
          <span className="nm">{a.name}</span>
          {a.status === 'uploading' && <small>{Math.round(a.progress * 100)}%</small>}
          {a.status === 'error' && <small className="err">{a.error ?? 'Failed'}</small>}
          <button type="button" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(k, a.localId)}>
            <I n="x" size={12} />
          </button>
        </span>
      ))}
    </div>
  )
}

export function Composer({
  placeholder,
  model,
  modelFor,
  extra,
  plus,
  ctx,
  running,
  onSend,
  top,
  label = 'Message',
  seed,
  stopFor,
  allowWhileRunning,
}: {
  /** While running, typed text can still be sent (it queues on the
   * computer); Stop shows when the box is empty. */
  allowWhileRunning?: boolean
  placeholder: string
  /** The model chip; omitted in rooms, where each participant has its own. */
  model?: ComposerModel | null
  modelFor?: string
  extra?: ReactNode
  /** What the "+" sheet adds to and configures (#76): one button, one sheet. */
  plus?: { for: 'home' | 'chat' | 'cowork'; id?: string }
  /** The context ring: only the circle, tapped for the Context window card. */
  ctx?: { pct: number; for: 'home' | 'chat' | 'cowork'; id?: string }
  /** A run is going: the send button becomes Stop… */
  running?: boolean
  onSend: (text: string) => Promise<boolean | void> | boolean | void
  /** Above the text box (a room's "To" chips). */
  top?: ReactNode
  label?: string
  /** Text to put in the box (a tapped suggestion); `n` changes per tap. */
  seed?: { text: string; n: number }
  /** What Stop… stops. */
  stopFor?: { kind: string; id: string }
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  // Rooms (with `top`) take no attachments.
  const key = top === undefined ? attachKey(plus ?? { for: 'home' }) : null
  const files = attachments.use((s) => (key ? (s.by[key] ?? EMPTY) : EMPTY))
  const hasFiles = files.some((a) => a.status !== 'error')
  const insert = attachments.use((s) => s.insert)

  const grow = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  useEffect(() => {
    if (!seed) return
    setText(seed.text)
    ref.current?.focus()
    requestAnimationFrame(grow)
  }, [seed])

  // An @ reference or "Add to chat" asked for this composer.
  const textRef = useRef(text)
  textRef.current = text
  useEffect(() => {
    if (!insert || !key || insert.key !== key) return
    const cur = textRef.current
    const el = ref.current
    const at = el?.selectionStart ?? cur.length
    const before = cur.slice(0, at)
    const pad = before && !/\s$/.test(before) ? ' ' : ''
    insertInto(el, cur, (v) => {
      setText(v)
      requestAnimationFrame(grow)
    }, `${pad}${insert.text} `)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insert?.n])

  const send = async () => {
    const v = text.trim()
    if (!v && !hasFiles) return
    const sent = await onSend(v)
    // Keep what was typed unless the computer took it.
    if (sent) {
      setText('')
      requestAnimationFrame(grow)
    }
  }

  return (
    <div className="composer">
      <div className="cbox">
        {top}
        {key && <AttachmentChips k={key} />}
        <textarea
          ref={ref}
          rows={1}
          placeholder={placeholder}
          aria-label={label}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            grow()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="crow">
          {top === undefined && (
            <button type="button" className="ib" onClick={() => openSheet('plus', plus ?? { for: 'home' })} aria-label="Add and options">
              <I n="plus" />
            </button>
          )}
          {model !== undefined && (
            <button type="button" className="mp" onClick={() => openSheet('model', { for: modelFor })} data-testid="model-chip">
              {model ? <Avatar id={model.id} name={model.name} provider={model.provider} size={16} /> : <I n="cube" />}
              <span>{model?.name ?? 'Choose a model'}</span>
              <I n="chev" />
            </button>
          )}
          {extra}
          {ctx ? (
            <button
              type="button"
              className="tokr"
              onClick={() => openSheet('tokens', ctx)}
              aria-label={`Context window: ${Math.round(ctx.pct)}% used`}
              data-testid="context-ring"
            >
              <span className="ring" style={{ ['--p' as string]: `${Math.min(100, Math.max(0, ctx.pct))}%` }} />
            </button>
          ) : (
            <span className="tok" />
          )}
          <DictateButton
            insert={(words) =>
              insertInto(ref.current, text, (v) => {
                setText(v)
                requestAnimationFrame(grow)
              }, words)
            }
          />
          {running && !(allowWhileRunning && (text.trim() || hasFiles)) ? (
            <button type="button" className="send stop" onClick={() => openSheet('stop', stopFor)} aria-label="Stop…">
              <I n="sq" />
            </button>
          ) : (
            <button
              type="button"
              className={`send${text.trim() || hasFiles ? '' : ' off'}`}
              onClick={() => void send()}
              aria-label="Send Message"
            >
              <I n="up" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
