// New chat: the Chat / Cowork / Room switch, what is waiting for you, and a
// composer that starts the conversation on the computer.
import { useEffect, useState } from 'react'
import type { HomeMode } from '../state/router'
import { TopMain } from '../shell/TopBar'
import { Composer } from '../shell/Composer'
import { I } from '../ui/icons'
import { greet } from '../ui/format'
import { app, client, go, openSheet, sendMessage, toast, useApp } from '../state/app'
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
  const questions = status.data?.questionsWaiting ?? 0
  const asks = useRpc('asks.list', {}, questions > 0).data?.asks ?? []
  return <>
    {asks.map((a) => <button key={a.requestId} type="button" className="waitcard" onClick={() => go({ name: 'cowork', id: a.threadId })} data-testid="question-waiting"><I n="hand" size={18} style={{ color: 'var(--warning)' }} /><span className="tx"><b>{sessions.find((s) => s.id === a.threadId)?.title ?? 'A Cowork session'} has a question</b><small>{a.questions[0]?.question}</small></span><I n="chevr" style={{ color: 'var(--muted-foreground)' }} /></button>)}
    {waiting > 0 && <button type="button" className="waitcard" onClick={() => (first ? go(routeFor(first.threadId, sessions)) : go({ name: 'notifications' }))} data-testid="approvals-waiting"><I n="shield" size={18} /><span className="tx"><b>{waiting} {waiting === 1 ? 'approval' : 'approvals'} waiting</b>{first && <small>{sessions.find((s) => s.id === first.threadId)?.title ?? first.toolName}{first.subject ? ` · ${first.subject}` : ''}</small>}</span><I n="chevr" style={{ color: 'var(--muted-foreground)' }} /></button>}
    {rooms.slice(0, 2).map((r) => <button key={r.id} type="button" className="waitcard" onClick={() => go({ name: 'room', id: r.id })}><I n="hand" size={18} style={{ color: 'var(--warning)' }} /><span className="tx"><b>{r.title} is waiting for you</b><small>Choose who speaks next or reply</small></span><I n="chevr" /></button>)}
  </>
}

function Suggestions({ items, onPick, label }: { items: string[]; onPick: (s: string) => void; label: string }) {
  return <><div className="ssec" style={{ paddingTop: 18 }}>{label}</div><div className="sugg">{items.map((s) => <button key={s} type="button" onClick={() => onPick(s)}><I n="sparkles" />{s}</button>)}</div></>
}

export default function Home() {
  const mode = useApp((s) => s.homeMode)
  const composer = useApp((s) => s.composer)
  const models = useRpc('models.list', {})
  const { sessions } = useSessions()
  // Keyed on the id list, not `sessions`, so a status tick on any session does not refetch every cowork.get.
  const coworkIds = sessions.filter((s) => s.kind === 'cowork').slice(0, 10).map((s) => s.id).join(',')
  const [folders, setFolders] = useState<string[]>([])
  const [folder, setFolder] = useState<string | null>(null)
  const [seed, setSeed] = useState<{ text: string; n: number }>()

  useEffect(() => {
    if (mode !== 'cowork') return
    let live = true
    const ids = coworkIds.split(',').filter(Boolean)
    void Promise.all(ids.map((id) => client().rpc('cowork.get', { id }).catch(() => null))).then((details) => {
      if (!live) return
      const unique = [...new Set(details.flatMap((d) => d?.folder ? [d.folder] : []))]
      setFolders(unique)
      setFolder((current) => current && unique.includes(current) ? current : unique[0] ?? null)
    })
    return () => { live = false }
  }, [mode, coworkIds])

  const setMode = (m: HomeMode) => app.set({ homeMode: m })
  const fill = (text: string) => setSeed((s) => ({ text, n: (s?.n ?? 0) + 1 }))

  const createRoom = async (objective: string) => {
    const choices = models.data?.models ?? []
    if (choices.length < 2) {
      toast('Set up at least two models on the computer before creating a Room.')
      return false
    }
    const picked = choices.slice(0, Math.min(3, choices.length))
    try {
      const result = await client().rpc('room.create', {
        title: objective.trim().slice(0, 60) || 'New room',
        objective: objective.trim(),
        mode: 'round-robin',
        participants: picked.map((m, i) => ({
          name: m.name || `Participant ${i + 1}`,
          role: i === 0 ? 'proposer' : i === 1 ? 'reviewer' : 'cross-checker',
          model: { id: m.id, provider: m.provider },
          toolAccess: 'none',
        })),
        moderator: { enabled: false },
      })
      go({ name: 'room', id: result.id })
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the Room')
      return false
    }
  }

  const send = async (text: string) => {
    if (mode === 'room') return createRoom(text)
    const model = composer.model ? { id: composer.model.id, provider: composer.model.provider } : undefined
    const r = mode === 'chat'
      ? await sendMessage('chat.send', { text, new: true, model, webSearch: composer.web, reasoning: composer.reason })
      : await sendMessage('cowork.send', {
          text,
          new: true,
          model,
          mode: composer.cwMode,
          ...(folder ? { folder } : {}),
          ...(composer.access === 'review-only' ? { access: composer.access } : {}),
        })
    if (r) go({ name: r.kind, id: r.id })
    return r !== undefined
  }

  return <>
    <TopMain crumb="Workspace" title="New chat" />
    <div className="scroll">
      <div className="hero"><h2>{greet()}</h2><p>Ask anything, attach files, or hand a bigger task to Cowork.</p><div className="segm" role="group" aria-label="Start"><button type="button" aria-pressed={mode === 'chat'} onClick={() => setMode('chat')}><I n="pen" />Chat</button><button type="button" aria-pressed={mode === 'cowork'} onClick={() => setMode('cowork')}><I n="cowork" />Cowork</button><button type="button" aria-pressed={mode === 'room'} onClick={() => setMode('room')}><I n="rooms" />Room</button></div></div>
      {mode === 'chat' && <><WaitCards /><Suggestions label="Suggestions" items={CHAT_SUGGESTIONS} onPick={fill} /><div className="tempbar"><I n="eye" size={14} />Nothing is saved until you send · <u style={{ cursor: 'pointer' }} onClick={() => openSheet('temp')}>Temporary chat</u></div></>}
      {mode === 'cowork' && <><div className="frame" style={{ padding: '10px 12px', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}><div className="kv"><span>Folder</span><span>{folder ? folder.split(/[\\/]/).pop() : 'No recent folder'}</span></div>{folders.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{folders.map((f) => <button key={f} type="button" className={`chip${folder === f ? ' on' : ''}`} aria-pressed={folder === f} onClick={() => setFolder(f)}><I n="folder" size={12} />{f.split(/[\\/]/).pop()}</button>)}</div>}<div className="kv"><span>What Flint may do</span><span>{modeLabel(composer.cwMode)?.label}</span></div><div className="kv"><span>Where changes go</span><span>{accessLabel(composer.access)?.label}</span></div></div><Suggestions label="Try" items={COWORK_SUGGESTIONS} onPick={fill} /></>}
      {mode === 'room' && <><div className="ssec" style={{ paddingTop: 18 }}>Start from a template</div><div className="sugg">{[['Architecture review','Several models and a moderator'],['Naming','3 models · round-robin'],['Cross-check','2 models verify each other'],['Debate','Two sides and a moderator']].map(([t,s]) => <button key={t} type="button" onClick={() => openSheet('roomnew', { template: t })}><I n="rooms" /><span style={{ flex: 1 }}>{t}<br /><small className="muted">{s}</small></span></button>)}</div></>}
    </div>
    <Composer key={mode} placeholder={mode === 'chat' ? 'Ask me anything...' : mode === 'cowork' ? 'Describe the task…' : 'What should the participants discuss or decide?'} model={mode === 'cowork' ? composer.model : undefined} modelFor="home" plus={mode === 'room' ? undefined : { for: mode === 'cowork' ? 'cowork' : 'home' }} ctx={mode === 'room' ? undefined : { pct: 0, for: 'home' }} extra={mode === 'chat' ? undefined : mode === 'cowork' ? <><button type="button" className="ib" onClick={() => openSheet('mode')} aria-label="What Flint may do"><I n="shield" /></button><button type="button" className="ib" onClick={() => openSheet('access')} aria-label="Where changes go"><I n="folder" /></button></> : <button type="button" className="ib" onClick={() => openSheet('roomnew')} aria-label="Configure room"><I n="users" /></button>} onSend={send} seed={seed} />
    {mode === 'chat' && <div className="runrow"><button type="button" className="rq" onClick={() => openSheet('reason', { for: 'home' })}>{composer.reason === 'off' ? 'Off' : composer.reason === 'on' ? 'Thinking' : 'Recommended'}</button><button type="button" className="rq" onClick={() => openSheet('profile', {})}><I n="wand" size={13} />Auto</button><button type="button" className="rq rm2" data-testid="model-chip" onClick={() => openSheet('model', { for: 'home' })}><span>{composer.model?.name ?? 'Choose a model'}</span></button></div>}
  </>
}
