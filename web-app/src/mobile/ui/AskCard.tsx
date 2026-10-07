// A question a Cowork run is waiting on, as the desktop's question card: one
// question at a time, its options (with the recommended one marked), your own
// words instead, Skip. Plan review shows the staged plan above its choices.
// Once answered -- here, on the computer or on another phone -- it becomes one
// line saying so.
import { useEffect, useState } from 'react'
import type { RemoteAsk, RemoteAskAnswer } from '@/lib/remote/protocol'
import { respondAsk } from '../state/app'
import { useLive } from '../state/live'
import { ResolvedLine } from './live'
import { t } from '../i18n'

export function AskCard({ a }: { a: RemoteAsk }) {
  const resolved = useLive((s) => s.resolved[a.requestId])
  const [index, setIndex] = useState(0)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [own, setOwn] = useState<Record<string, boolean>>({})
  const [text, setText] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  // A new request starts clean: earlier picks must not answer it.
  useEffect(() => {
    setIndex(0)
    setPicked({})
    setOwn({})
    setText({})
  }, [a.requestId])

  if (resolved) return <ResolvedLine r={resolved} />
  const q = a.questions[Math.min(index, a.questions.length - 1)]
  if (!q) return null
  const picks = picked[q.id] ?? []
  const writing = own[q.id] === true
  const answered = (id: string) => (own[id] ? (text[id] ?? '').trim().length > 0 : (picked[id] ?? []).length > 0)
  const last = index >= a.questions.length - 1

  const toggle = (label: string) => {
    setOwn((o) => ({ ...o, [q.id]: false }))
    setPicked((p) => {
      const cur = p[q.id] ?? []
      if (!q.multi) return { ...p, [q.id]: [label] }
      return { ...p, [q.id]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  }

  const send = async (answers: RemoteAskAnswer[] | null) => {
    setBusy(true)
    await respondAsk(a, answers)
    setBusy(false)
  }

  const submit = () => {
    if (!last) {
      setIndex(index + 1)
      return
    }
    void send(
      a.questions.map((one) =>
        own[one.id]
          ? { id: one.id, selected: [], custom_input: (text[one.id] ?? '').trim() }
          : { id: one.id, selected: picked[one.id] ?? [] }
      )
    )
  }

  return (
    <div className="ap2 ask" data-testid="ask-card">
      <div className="aph">
        <span>{t('notifications.question')}</span>
        {a.questions.length > 1 && (
          <span className="aptool">
            {index + 1}/{a.questions.length}
          </span>
        )}
      </div>
      <div className="apt">{q.question}</div>
      {q.id === 'plan_review' && a.plan && a.plan.length > 0 && (
        <div className="askplan" data-testid="ask-plan">
          {a.plan.map((phase, pi) => (
            <div key={pi}>
              {phase.name.trim() && <b>{phase.name}</b>}
              <ol>
                {phase.tasks.map((task, ti) => (
                  <li key={ti} className={task.done ? 'done' : undefined}>
                    {task.content}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
      <div className="askopts" role={q.multi ? 'group' : 'radiogroup'}>
        {q.options.map((o, i) => {
          const on = !writing && picks.includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              role={q.multi ? 'checkbox' : 'radio'}
              aria-checked={on}
              className={`askopt${on ? ' on' : ''}`}
              data-testid="ask-option"
              onClick={() => toggle(o.label)}
            >
              <span className={`askmark${q.multi ? ' multi' : ''}`} aria-hidden />
              <span className="tx">
                <b>
                  {o.label}
                  {q.recommended === i && <em>{t('ask.recommended')}</em>}
                </b>
                {o.description && <small>{o.description}</small>}
              </span>
            </button>
          )
        })}
        <button
          type="button"
          role={q.multi ? 'checkbox' : 'radio'}
          aria-checked={writing}
          className={`askopt${writing ? ' on' : ''}`}
          data-testid="ask-own"
          onClick={() => setOwn((o) => ({ ...o, [q.id]: !writing }))}
        >
          <span className={`askmark${q.multi ? ' multi' : ''}`} aria-hidden />
          <span className="tx">
            <b>{t('ask.somethingElse')}</b>
          </span>
        </button>
        {writing && (
          <textarea
            className="askown"
            rows={2}
            autoFocus
            aria-label={t('ask.yourAnswer')}
            placeholder={t('ask.typeAnswer')}
            value={text[q.id] ?? ''}
            onChange={(e) => setText((prev) => ({ ...prev, [q.id]: e.target.value }))}
          />
        )}
      </div>
      <div className="apf">
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void send(null)}>
          {t('ask.skip')}
        </button>
        <span style={{ flex: 1 }} />
        {index > 0 && (
          <button type="button" className="btn" disabled={busy} onClick={() => setIndex(index - 1)}>
            {t('ask.back')}
          </button>
        )}
        <button type="button" className="btn pri" disabled={busy || !answered(q.id)} onClick={submit} data-testid="ask-submit">
          {last ? t('ask.send') : t('ask.continue')}
        </button>
      </div>
    </div>
  )
}
