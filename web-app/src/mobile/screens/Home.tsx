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
import { t } from '../i18n'

const CHAT_SUGGESTIONS = [
  t('home.chatSuggestions.error'),
  t('home.chatSuggestions.summarise'),
  t('home.chatSuggestions.releaseNotes'),
  t('home.chatSuggestions.compare'),
]
const COWORK_SUGGESTIONS = [
  t('home.coworkSuggestions.explain'),
  t('home.coworkSuggestions.todos'),
  t('home.coworkSuggestions.tests'),
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
  const promptsWaiting = status.data?.promptsWaiting ?? 0
  const prompts = useRpc('prompts.list', {}, promptsWaiting > 0).data?.prompts ?? []
  return <>
    {prompts.map((p) => <button key={p.id} type="button" className="waitcard" onClick={() => go(p.threadId ? routeFor(p.threadId, sessions) : { name: 'notifications' })} data-testid="prompt-waiting"><I n="shield" size={18} /><span className="tx"><b>{t('home.needsYou')}</b><small>{p.title}</small></span><I n="chevr" style={{ color: 'var(--muted-foreground)' }} /></button>)}
    {asks.map((a) => <button key={a.requestId} type="button" className="waitcard" onClick={() => go({ name: 'cowork', id: a.threadId })} data-testid="question-waiting"><I n="hand" size={18} style={{ color: 'var(--warning)' }} /><span className="tx"><b>{t('home.hasQuestion', { title: sessions.find((s) => s.id === a.threadId)?.title ?? t('home.aCoworkSession') })}</b><small>{a.questions[0]?.question}</small></span><I n="chevr" style={{ color: 'var(--muted-foreground)' }} /></button>)}
    {waiting > 0 && <button type="button" className="waitcard" onClick={() => (first ? go(routeFor(first.threadId, sessions)) : go({ name: 'notifications' }))} data-testid="approvals-waiting"><I n="shield" size={18} /><span className="tx"><b>{t('home.approvalsWaiting', { count: waiting })}</b>{first && <small>{sessions.find((s) => s.id === first.threadId)?.title ?? first.toolName}{first.subject ? ` · ${first.subject}` : ''}</small>}</span><I n="chevr" style={{ color: 'var(--muted-foreground)' }} /></button>}
    {rooms.slice(0, 2).map((r) => <button key={r.id} type="button" className="waitcard" onClick={() => go({ name: 'room', id: r.id })}><I n="hand" size={18} style={{ color: 'var(--warning)' }} /><span className="tx"><b>{t('home.roomWaiting', { title: r.title })}</b><small>{t('home.roomWaitingHint')}</small></span><I n="chevr" /></button>)}
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
      toast(t('home.needTwoModels'))
      return false
    }
    const picked = choices.slice(0, Math.min(3, choices.length))
    try {
      const result = await client().rpc('room.create', {
        title: objective.trim().slice(0, 60) || t('home.newRoom'),
        objective: objective.trim(),
        mode: 'round-robin',
        participants: picked.map((m, i) => ({
          name: m.name || t('home.participant', { n: i + 1 }),
          role: i === 0 ? 'proposer' : i === 1 ? 'reviewer' : 'cross-checker',
          model: { id: m.id, provider: m.provider },
          toolAccess: 'none',
        })),
        moderator: { enabled: false },
      })
      go({ name: 'room', id: result.id })
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : t('home.createRoomFailed'))
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
    <TopMain crumb={t('common.workspace')} title={t('home.title')} />
    <div className="scroll">
      <div className="hero"><h2>{greet()}</h2><p>{t('home.hero')}</p><div className="segm" role="group" aria-label={t('home.start')}><button type="button" aria-pressed={mode === 'chat'} onClick={() => setMode('chat')}><I n="pen" />{t('home.modes.chat')}</button><button type="button" aria-pressed={mode === 'cowork'} onClick={() => setMode('cowork')}><I n="cowork" />{t('home.modes.cowork')}</button><button type="button" aria-pressed={mode === 'room'} onClick={() => setMode('room')}><I n="rooms" />{t('home.modes.room')}</button></div></div>
      {mode === 'chat' && <><WaitCards /><Suggestions label={t('home.suggestions')} items={CHAT_SUGGESTIONS} onPick={fill} /><div className="tempbar"><I n="eye" size={14} />{t('home.tempNote')} · <u style={{ cursor: 'pointer' }} onClick={() => openSheet('temp')}>{t('home.tempChat')}</u></div></>}
      {mode === 'cowork' && <><div className="frame" style={{ padding: '10px 12px', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}><div className="kv"><span>{t('home.folder')}</span><span>{folder ? folder.split(/[\\/]/).pop() : t('home.noRecentFolder')}</span></div>{folders.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{folders.map((f) => <button key={f} type="button" className={`chip${folder === f ? ' on' : ''}`} aria-pressed={folder === f} onClick={() => setFolder(f)}><I n="folder" size={12} />{f.split(/[\\/]/).pop()}</button>)}</div>}<div className="kv"><span>{t('home.mayDo')}</span><span>{modeLabel(composer.cwMode)?.label}</span></div><div className="kv"><span>{t('home.changesGo')}</span><span>{accessLabel(composer.access)?.label}</span></div></div><Suggestions label={t('home.try')} items={COWORK_SUGGESTIONS} onPick={fill} /></>}
      {mode === 'room' && <><div className="ssec" style={{ paddingTop: 18 }}>{t('home.template')}</div><div className="sugg">{[['Architecture review', t('home.templates.architecture.name'), t('home.templates.architecture.sub')], ['Naming', t('home.templates.naming.name'), t('home.templates.naming.sub')], ['Cross-check', t('home.templates.crossCheck.name'), t('home.templates.crossCheck.sub')], ['Debate', t('home.templates.debate.name'), t('home.templates.debate.sub')]].map(([id, name, sub]) => <button key={id} type="button" onClick={() => openSheet('roomnew', { template: id })}><I n="rooms" /><span style={{ flex: 1 }}>{name}<br /><small className="muted">{sub}</small></span></button>)}</div></>}
    </div>
    <Composer key={mode} placeholder={mode === 'chat' ? t('chat.placeholder') : mode === 'cowork' ? t('home.placeholderCowork') : t('home.placeholderRoom')} model={mode === 'cowork' ? composer.model : undefined} modelFor="home" plus={mode === 'room' ? undefined : { for: mode === 'cowork' ? 'cowork' : 'home' }} ctx={mode === 'room' ? undefined : { pct: 0, for: 'home' }} extra={mode === 'chat' ? undefined : mode === 'cowork' ? <><button type="button" className="ib" onClick={() => openSheet('mode')} aria-label={t('home.mayDo')}><I n="shield" /></button><button type="button" className="ib" onClick={() => openSheet('access')} aria-label={t('home.changesGo')}><I n="folder" /></button></> : <button type="button" className="ib" onClick={() => openSheet('roomnew')} aria-label={t('home.configureRoom')}><I n="users" /></button>} onSend={send} seed={seed} />
    {mode === 'chat' && <div className="runrow"><button type="button" className="rq" onClick={() => openSheet('reason', { for: 'home' })}>{composer.reason === 'off' ? t('home.reason.off') : composer.reason === 'on' ? t('home.reason.on') : t('home.reason.recommended')}</button><button type="button" className="rq" onClick={() => openSheet('profile', {})}><I n="wand" size={13} />{t('chat.auto')}</button><button type="button" className="rq rm2" data-testid="model-chip" onClick={() => openSheet('model', { for: 'home' })}><span>{composer.model?.name ?? t('chat.chooseModel')}</span></button></div>}
  </>
}
