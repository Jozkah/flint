// New chat: the Chat / Cowork / Room switch, what is waiting for you, and a
// composer that starts the conversation on the computer.
import { useState } from 'react'
import type { HomeMode } from '../state/router'
import { TopMain } from '../shell/TopBar'
import { Composer } from '../shell/Composer'
import { I } from '../ui/icons'
import { greet } from '../ui/format'
import { app, go, notYet, openSheet, sendMessage, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { routeFor, useSessions } from '../state/sessions'
import { accessLabel, modeLabel } from '../shell/labels'

const CHAT_SUGGESTIONS = [
  'Explain this error message',
  'Summarise a document I attach',
  'Draft release notes from a list of changes',
  'Compare two approaches and recommend one',
]
const COWORK_SUGGESTIONS = [
  'Explain how this project is put together',
  'Find every TODO and group them',
  'Write tests for the part I point you at',
]

function WaitCards() {
  const status = useRpc('status', {})
  const waiting = status.data?.approvalsWaiting ?? 0
  const approvals = useRpc('approvals.list', {}, waiting > 0)
  const { sessions } = useSessions()
  const list = approvals.data?.approvals ?? []
  const rooms = sessions.filter((s) => s.kind === 'room' && s.status === 'waiting')
  const first = list[0]
  return (
    <>
      {waiting > 0 && (
        <button
          type="button"
          className="waitcard"
          onClick={() => (first ? go(routeFor(first.threadId, sessions)) : go({ name: 'notifications' }))}
          data-testid="approvals-waiting"
        >
          <I n="shield" size={18} />
          <span className="tx">
            <b>
              {waiting} {waiting === 1 ? 'approval' : 'approvals'} waiting
            </b>
            {first && (
              <small>
                {sessions.find((s) => s.id === first.threadId)?.title ?? first.toolName}
                {first.subject ? ` · ${first.subject}` : ''}
              </small>
            )}
          </span>
          <I n="chevr" style={{ color: 'var(--muted-foreground)' }} />
        </button>
      )}
      {rooms.slice(0, 2).map((r) => (
        <button
          key={r.id}
          type="button"
          className="waitcard"
          style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
          onClick={() => go({ name: 'room', id: r.id })}
        >
          <I n="hand" size={18} style={{ color: 'var(--warning)' }} />
          <span className="tx">
            <b>{r.title} is waiting for you</b>
            <small>Choose who speaks next or reply</small>
          </span>
          <I n="chevr" style={{ color: 'var(--muted-foreground)' }} />
        </button>
      ))}
    </>
  )
}

function Suggestions({ items, onPick, label }: { items: string[]; onPick: (s: string) => void; label: string }) {
  return (
    <>
      <div className="ssec" style={{ paddingTop: 18 }}>
        {label}
      </div>
      <div className="sugg">
        {items.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)}>
            <I n="sparkles" />
            {s}
          </button>
        ))}
      </div>
    </>
  )
}

export default function Home() {
  const mode = useApp((s) => s.homeMode)
  const composer = useApp((s) => s.composer)

  // Do not guess the desktop's selected model from the model list. When the
  // phone has not explicitly picked a model, omit it and let the desktop's
  // normal new-chat/new-Cowork path use its real current selection.
  const setMode = (m: HomeMode) => app.set({ homeMode: m })
  const [seed, setSeed] = useState<{ text: string; n: number }>()
  const fill = (text: string) => setSeed((s) => ({ text, n: (s?.n ?? 0) + 1 }))

  const send = async (text: string) => {
    if (mode === 'room') {
      notYet('Creating a room')
      return false
    }
    const model = composer.model ? { id: composer.model.id, provider: composer.model.provider } : undefined
    const r =
      mode === 'chat'
        ? await sendMessage('chat.send', { text, new: true, model, webSearch: composer.web, reasoning: composer.reason })
        : await sendMessage('cowork.send', {
            text,
            new: true,
            model,
            mode: composer.cwMode,
            ...(composer.access === 'review-only' ? { access: composer.access } : {}),
          })
    if (r) go({ name: r.kind, id: r.id })
    return r !== undefined
  }

  return (
    <>
      <TopMain crumb="Workspace" title="New chat" />
      <div className="scroll">
        <div className="hero">
          <h2>{greet()}</h2>
          <p>Ask anything, attach files, or hand a bigger task to Cowork.</p>
          <div className="segm" role="group" aria-label="Start">
            <button type="button" aria-pressed={mode === 'chat'} onClick={() => setMode('chat')}>
              <I n="pen" />
              Chat
            </button>
            <button type="button" aria-pressed={mode === 'cowork'} onClick={() => setMode('cowork')}>
              <I n="cowork" />
              Cowork
            </button>
            <button type="button" aria-pressed={mode === 'room'} onClick={() => setMode('room')}>
              <I n="rooms" />
              Room
            </button>
          </div>
        </div>
        {mode === 'chat' && (
          <>
            <WaitCards />
            <Suggestions label="Suggestions" items={CHAT_SUGGESTIONS} onPick={fill} />
            <div className="tempbar">
              <I n="eye" size={14} />
              Nothing is saved until you send ·{' '}
              <u style={{ cursor: 'pointer' }} onClick={() => openSheet('temp')}>
                Temporary chat
              </u>
            </div>
          </>
        )}
        {mode === 'cowork' && (
          <>
            <div className="frame" style={{ padding: '10px 12px', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="kv">
                <span>Folder</span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <I n="folder" size={13} />
                  Chosen on the computer
                </span>
              </div>
              <div className="kv">
                <span>What Flint may do</span>
                <span>{modeLabel(composer.cwMode)?.label}</span>
              </div>
              <div className="kv">
                <span>Where changes go</span>
                <span>{accessLabel(composer.access)?.label}</span>
              </div>
            </div>
            <Suggestions label="Try" items={COWORK_SUGGESTIONS} onPick={fill} />
          </>
        )}
        {mode === 'room' && (
          <>
            <div className="ssec" style={{ paddingTop: 18 }}>
              Start from a template
            </div>
            <div className="sugg">
              {[
                ['Architecture review', 'Several models and a moderator'],
                ['Naming', '3 models · round-robin'],
                ['Cross-check', '2 models verify each other'],
                ['Debate', 'Two sides and a moderator'],
              ].map(([t, s]) => (
                <button key={t} type="button" onClick={() => openSheet('roomnew', { template: t })}>
                  <I n="rooms" />
                  <span style={{ flex: 1 }}>
                    {t}
                    <br />
                    <small className="muted">{s}</small>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <Composer
        key={mode}
        placeholder={
          mode === 'chat'
            ? 'Ask me anything...'
            : mode === 'cowork'
              ? 'Describe the task…'
              : 'What should the participants discuss or decide?'
        }
        model={mode === 'room' ? undefined : composer.model}
        modelFor="home"
        tokens="0"
        extra={
          mode === 'chat' ? (
            <>
              <button type="button" className="ib" onClick={() => openSheet('tools')} aria-label="Tools">
                <I n="wrench" />
              </button>
              <button
                type="button"
                className={`ib${composer.web ? ' on' : ''}`}
                aria-label="Web Search"
                aria-pressed={composer.web}
                onClick={() => app.set((s) => ({ composer: { ...s.composer, web: !s.composer.web } }))}
              >
                <I n="globe" />
              </button>
              <button type="button" className="ib" onClick={() => openSheet('reason', { for: 'home' })} aria-label={`Reasoning: ${composer.reason}`}>
                <I n="bulb" />
              </button>
            </>
          ) : mode === 'cowork' ? (
            <>
              <button type="button" className="ib" onClick={() => openSheet('mode')} aria-label="What Flint may do">
                <I n="shield" />
              </button>
              <button type="button" className="ib" onClick={() => openSheet('access')} aria-label="Where changes go">
                <I n="folder" />
              </button>
            </>
          ) : (
            <button type="button" className="ib" onClick={() => openSheet('roomnew')} aria-label="Participants">
              <I n="users" />
            </button>
          )
        }
        onSend={send}
        seed={seed}
      />
    </>
  )
}
