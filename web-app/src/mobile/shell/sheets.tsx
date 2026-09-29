import { useMemo, useState, type ReactNode } from 'react'
import type { NotificationPrefs, RemoteApproval, RemoteModel, SessionKind } from '@/lib/remote/protocol'
import { Avatar, Empty, FlintMark, Grab, Kv, Opt, Sw } from '../ui/bits'
import { I, type IconId } from '../ui/icons'
import { act, app, client, closeSheet, go, openSheet, toast, useApp } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { reachLabel, useSessions } from '../state/sessions'
import { respond } from '../ui/respond'
import { usePhonePermissions } from '../ui/hooks'
import { DEFAULT_NOTIFY, roomAct } from '../state/controls'
import { ACCESS_MODES, COWORK_MODES } from './labels'

type Props = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const participantId = (p: Props) => str(p.participant)

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return <><Grab /><h3>{children}</h3>{sub && <p className="sh">{sub}</p>}</>
}

function DesktopOnly({ title, sub = 'Available on the computer.' }: { title: ReactNode; sub?: ReactNode }) {
  return <div className="opt" aria-disabled="true"><I n="monitor" /><span className="tx"><b>{title}</b><small>{sub}</small></span></div>
}

function Action({ icon, label, run, danger = false, sub }: { icon: IconId; label: string; run: () => void; danger?: boolean; sub?: ReactNode }) {
  return <button type="button" className={`opt${danger ? ' dang' : ''}`} onClick={() => { closeSheet(); run() }}><I n={icon} /><span className="tx"><b>{label}</b>{sub && <small>{sub}</small>}</span></button>
}

async function mobileMutation(raw: Record<string, unknown>, ok?: string) {
  try {
    const result = await client().rpc('settings.set', raw as never) as unknown as Record<string, unknown>
    if (ok) toast(ok)
    invalidate(['sessions.list', 'rooms.get', 'cowork.get'])
    return result
  } catch (e) {
    toast(e instanceof Error ? e.message : 'The action failed')
    return null
  }
}

function ModelSheet({ props }: { props: Props }) {
  const target = str(props.for) ?? 'home'
  const { data, loading } = useRpc('models.list', {})
  const current = useApp((s) => s.composer.model)
  const [q, setQ] = useState('')
  const models = (data?.models ?? []).filter((m) => !q || `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q.toLowerCase()))
  const pick = (m: RemoteModel) => {
    const id = str(props.id)
    const participant = participantId(props)
    if (target === 'home') {
      app.set((s) => ({ composer: { ...s.composer, model: { id: m.id, provider: m.provider, name: m.name } } }))
      closeSheet(); toast(`Switched to ${m.name}`); return
    }
    if ((target === 'chat' || target === 'cowork') && id) {
      closeSheet(); void act('settings.set', { scope: target, id, model: { id: m.id, provider: m.provider } }, `Switched to ${m.name}`).then(() => invalidate(['cowork.get', 'sessions.list'])); return
    }
    if (target === 'room' && id && participant) {
      closeSheet(); void mobileMutation({ mobileOp: 'room.update', id, patch: { participants: [{ id: participant, model: { id: m.id, provider: m.provider } }] } }, `Switched to ${m.name}`)
    }
  }
  return <><Title>Model</Title><div className="sin"><I n="search" /><input placeholder="Search models..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" /></div>{loading && !data && <p className="sh">Loading models…</p>}{models.map((m) => <Opt key={`${m.provider}/${m.id}`} title={m.name} sub={`${m.providerName ?? m.provider}${m.local ? ' · Runs on this computer' : ''}${m.loaded ? ' · Loaded' : ''}`} selected={target === 'home' && current?.id === m.id && current.provider === m.provider} lead={<Avatar id={m.id} name={m.name} provider={m.provider} size={28} square />} onClick={() => pick(m)} />)}{data && models.length === 0 && <p className="sh">No models match.</p>}<div className="ssec" /><DesktopOnly title="Parameters" sub="Output, context, compaction and sampling are configured on the computer." /></>
}

function ReasonSheet({ props }: { props: Props }) {
  const target = str(props.for) ?? 'home'
  const id = str(props.id)
  const participant = participantId(props)
  const composer = useApp((s) => s.composer)
  const setReason = (reason: 'auto' | 'on' | 'off', label: string) => {
    if (target === 'home') {
      app.set((s) => ({ composer: { ...s.composer, reason } })); closeSheet(); toast(label); return
    }
    if (target === 'chat' && id) {
      closeSheet(); void act('settings.set', { scope: 'chat', id, reasoning: reason }, label); return
    }
    if (target === 'room' && id && participant) {
      closeSheet(); void mobileMutation({ mobileOp: 'room.update', id, patch: { participants: [{ id: participant, reasoning: { mode: reason } }] } }, label)
    }
  }
  if (target === 'cowork') return <><Title sub="This Cowork session">Reasoning</Title><DesktopOnly title="Reasoning mode" sub="Cowork reasoning is bound to the desktop session/model settings and is read-only on the phone." /></>
  return <><Title>Reasoning</Title>{([['auto','Auto',"Use the model's default."],['on','On','Force reasoning on.'],['off','Off','Disable reasoning.']] as const).map(([v,t,s]) => <Opt key={v} title={t} sub={s} selected={target === 'home' && composer.reason === v} onClick={() => setReason(v, `Reasoning: ${t}`)} />)}<div className="ssec" /><DesktopOnly title="Reasoning effort / thinking budget" sub="Provider-specific effort and context budgets stay with the persisted desktop model settings." /></>
}

function ModeSheet({ props }: { props: Props }) {
  const current = str(props.value) ?? app.get().composer.cwMode
  const id = str(props.id)
  return <><Title>What Flint may do</Title>{COWORK_MODES.map((m) => <Opt key={m.id} title={m.label} sub={m.sub} selected={current === m.id} onClick={() => { closeSheet(); if (!id) app.set((s) => ({ composer: { ...s.composer, cwMode: m.id } })); else void act('settings.set', { scope: 'cowork', id, mode: m.id }, m.label).then(() => invalidate(['cowork.get'])) }} />)}</>
}

function AccessSheet({ props }: { props: Props }) {
  const current = str(props.value) ?? app.get().composer.access
  const id = str(props.id)
  return <><Title sub="Write access requires confirmation on the computer.">Where changes go</Title>{ACCESS_MODES.map((m) => m.id === 'review-only' ? <Opt key={m.id} title={m.label} sub={m.sub} selected={current === m.id} onClick={() => { closeSheet(); if (!id) app.set((s) => ({ composer: { ...s.composer, access: m.id } })); else void act('settings.set', { scope: 'cowork', id, access: m.id }, 'Review only').then(() => invalidate(['cowork.get'])) }} /> : <DesktopOnly key={m.id} title={m.label} sub={`${m.sub} Computer confirmation required.`} />)}</>
}

function StopSheet({ props }: { props: Props }) {
  const kind = str(props.kind) as SessionKind | undefined
  const id = str(props.id)
  return <><Title>Stop…</Title><Action icon="sq" label="Stop current task" run={() => { if (kind && id) void act('run.stop', { kind, id }, 'Stopped.') }} /><Action icon="alert" label="Stop all activity" danger run={() => void act('run.stop', { all: true }, 'Stopped everything.')} /></>
}

function PermDetailsSheet({ props }: { props: Props }) {
  const a = props.approval as RemoteApproval | undefined
  const perms = usePhonePermissions()
  if (!a) return <Title>Permission details</Title>
  return <><Title sub="Choose how far this permission goes">Permission details</Title><div className="scopes">{a.scopes.filter((s) => s.scope !== 'always' || perms.alwaysAllow).map((s, i) => <button key={s.scope} type="button" className={`scope${i === 0 ? ' sug' : ''}`} disabled={!perms.approvals} onClick={() => { closeSheet(); void respond(a, 'allow', s.scope, s.label) }}><b>{s.label}{s.broader && <span className="broader">● Broader</span>}</b><small>{perms.approvals ? s.explanation : 'Approvals from phones are disabled on the computer.'}</small></button>)}</div><div className="ssec">Technical details</div><Kv k="Tool" v={<span className="mono">{a.toolName}</span>} /><Kv k="Server" v={a.serverName ?? 'Built in'} /><div className="cmd">{a.argumentsJson}</div></>
}

function RunsSheet() {
  const { data } = useRpc('status', {})
  const { sessions } = useSessions()
  return <><Title>Runs in progress</Title>{(data?.runs ?? []).length === 0 && <p className="sh">Nothing is running.</p>}{(data?.runs ?? []).map((r) => { const s = sessions.find((x) => x.id === r.id); return <Opt key={`${r.kind}:${r.id}`} title={s?.title ?? 'Untitled'} sub={`${r.kind === 'room' ? 'Room' : r.kind === 'cowork' ? 'Cowork' : 'Chat'} · running`} lead={<FlintMark size={28} />} onClick={() => go({ name: r.kind, id: r.id })} /> })}</>
}

function ConnSheet() {
  const computer = useApp((s) => s.computerName) ?? 'Your computer'
  const conn = useApp((s) => s.conn)
  const status = useRpc('status', {})
  const sys = useRpc('system.info', {})
  return <><Title>Computers</Title><Opt title={computer} sub={`${conn} · ${reachLabel()} · ${status.data?.modelsLoaded ?? 0} models loaded`} selected lead={<I n="monitor" />} /><Kv k="Route" v={<span className="mono">{location.host}</span>} /><Kv k="Local API" v={sys.data ? (sys.data.localApi.running ? 'On' : 'Off') : '—'} /><Action icon="monitor" label="System Monitor" run={() => go({ name: 'system' })} /><Action icon="settings" label="Remote access" run={() => go({ name: 'remote' })} /></>
}

function PaletteSheet() {
  const [q, setQ] = useState('')
  const { sessions } = useSessions()
  const hits = useMemo(() => (q ? sessions.filter((s) => s.title.toLowerCase().includes(q.toLowerCase())) : sessions).slice(0, 12), [q, sessions])
  return <><Grab /><div className="sin"><I n="search" /><input placeholder="Type a command, page or conversation…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div><Opt title="New chat" lead={<I n="pen" />} onClick={() => go({ name: 'home', mode: 'chat' })} /><Opt title="New Cowork session" lead={<I n="cowork" />} onClick={() => go({ name: 'home', mode: 'cowork' })} /><Opt title="Rooms" lead={<I n="rooms" />} onClick={() => go({ name: 'rooms' })} /><div className="ssec">Conversations</div>{hits.map((s) => <Opt key={s.id} title={s.title || 'Untitled'} sub={s.group} onClick={() => go({ name: s.kind, id: s.id })} />)}</>
}

function VoteSheet({ props }: { props: Props }) {
  const [proposal, setProposal] = useState('')
  const id = str(props.id)
  return <><Title sub="Every participant answers yes or no, with a reason.">Call a vote</Title><label className="field">Proposal<input value={proposal} onChange={(e) => setProposal(e.target.value)} /></label><button type="button" className="btn pri big" disabled={!proposal.trim() || !id} onClick={() => { closeSheet(); if (id) void act('room.control', { id, action: 'vote', proposal: proposal.trim() }, 'Vote called.') }}>Call vote</button></>
}

const NOTIFY_ROWS: [keyof NotificationPrefs, string][] = [['approvals','An approval is waiting'],['runFinished','A run finishes'],['errors','A run fails or stops'],['roomTurns','A Room is waiting for you']]
function NotifSetSheet() {
  const { data } = useRpc('settings.get', {})
  const prefs = data?.notifications ?? DEFAULT_NOTIFY
  return <><Title>Notify me when</Title>{NOTIFY_ROWS.map(([k,label]) => <button key={k} type="button" className={`row${prefs[k] ? ' on' : ''}`} onClick={() => void act('settings.set', { key: 'notifications', value: { ...prefs, [k]: !prefs[k] } }).then(() => invalidate(['settings.get']))}><span className="tx"><b>{label}</b></span><Sw on={prefs[k]} /></button>)}</>
}

function ToolsSheet() {
  const { data } = useRpc('tools.list', {})
  return <><Title>Available tools</Title>{(data?.servers ?? []).map((s) => <div key={s.name} className="opt" aria-disabled="true"><I n="wrench" /><span className="tx"><b>{s.name}</b><small>{s.active ? 'On' : 'Off'} · managed on the computer</small></span></div>)}{data && data.servers.length === 0 && <Empty>No MCP servers are set up.</Empty>}</>
}

function RoomNewSheet({ props }: { props: Props }) {
  const models = useRpc('models.list', {})
  const template = str(props.template)
  const [title, setTitle] = useState(template ?? '')
  const [objective, setObjective] = useState('')
  const create = async () => {
    const choices = models.data?.models ?? []
    if (choices.length < 2) { toast('Set up at least two models on the computer first.'); return }
    const count = template === 'Cross-check' || template === 'Debate' ? 2 : Math.min(3, choices.length)
    const picked = choices.slice(0, count)
    const moderator = template === 'Architecture review' || template === 'Debate'
    closeSheet()
    const result = await mobileMutation({ mobileOp: 'room.create', input: { title: title.trim() || template || 'New room', objective: objective.trim(), mode: 'round-robin', participants: picked.map((m,i) => ({ name: m.name || `Participant ${i+1}`, role: i === 0 ? 'proposer' : i === 1 ? 'reviewer' : 'cross-checker', model: { id: m.id, provider: m.provider }, toolAccess: 'none' })), moderator: { enabled: moderator, ...(moderator ? { model: { id: picked[0].id, provider: picked[0].provider } } : {}) } } })
    const id = result && typeof result.id === 'string' ? result.id : null
    if (id) go({ name: 'room', id })
  }
  return <><Title sub={template ? `Template: ${template}` : 'Configure the room before creating it.'}>New room</Title><label className="field">Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Radar cache TTL" /></label><label className="field">Objective<input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should participants discuss or decide?" /></label><button type="button" className="btn pri big" disabled={!models.data || (models.data.models?.length ?? 0) < 2} onClick={() => void create()}>Create room</button></>
}

function copyId(props: Props) {
  const id = str(props.id); if (!id) return
  void navigator.clipboard?.writeText(id).then(() => toast('ID copied'), () => toast('Copy failed'))
}

function ThreadMenu({ props }: { props: Props }) {
  const id = str(props.id)
  const rename = () => { if (!id) return; const title = window.prompt('Chat name', str(props.title) ?? ''); if (title?.trim()) void mobileMutation({ mobileOp: 'thread.rename', id, title: title.trim() }, 'Renamed.') }
  const remove = () => { if (id && window.confirm('Delete this chat?')) void mobileMutation({ mobileOp: 'thread.delete', id }, 'Chat deleted.').then(() => go({ name: 'home' })) }
  return <><Title>{str(props.title) ?? 'Chat'}</Title><Action icon="edit" label="Rename" run={rename} /><Action icon="pin" label="Pin / unpin" run={() => { if (id) void mobileMutation({ mobileOp: 'thread.pin', id }, 'Updated.') }} /><DesktopOnly title="Move to group" /><Action icon="copy" label="Copy ID" run={() => copyId(props)} /><DesktopOnly title="Export" /><Action icon="trash" label="Delete" danger run={remove} /></>
}

function SessionMenu({ props }: { props: Props }) {
  const id = str(props.id)
  return <><Title>{str(props.title) ?? 'Cowork session'}</Title><Action icon="branch" label="Fork this session" run={() => { if (id) void mobileMutation({ mobileOp: 'cowork.fork', id }, 'Forked.').then((r) => { const next = r && typeof r.id === 'string' ? r.id : null; if (next) go({ name: 'cowork', id: next }) }) }} /><DesktopOnly title="Export session" /><DesktopOnly title="File activity" /><Action icon="copy" label="Copy ID" run={() => copyId(props)} /><Action icon="trash" label="Delete session" danger run={() => { if (id && window.confirm('Delete this Cowork session?')) void mobileMutation({ mobileOp: 'cowork.delete', id }, 'Session deleted.').then(() => go({ name: 'home' })) }} /></>
}

const SHEETS: Record<string, (p: { props: Props }) => ReactNode> = {
  model: ModelSheet,
  reason: ReasonSheet,
  mode: ModeSheet,
  access: AccessSheet,
  stop: StopSheet,
  permdetails: PermDetailsSheet,
  vote: VoteSheet,
  runs: RunsSheet,
  conn: ConnSheet,
  palette: PaletteSheet,
  notifset: NotifSetSheet,
  tools: ToolsSheet,
  roomnew: RoomNewSheet,
  threadmenu: ThreadMenu,
  sessmenu: SessionMenu,
  roommenu: ({ props }) => <><Title>{str(props.title) ?? 'Room'}</Title><Action icon="pause" label="Pause" run={() => roomAct(props, 'pause', 'Paused.')} /><Action icon="play" label="Resume" run={() => roomAct(props, 'resume', 'Resumed.')} /><Action icon="vote" label="Call vote" run={() => openSheet('vote', props)} /><Action icon="file" label="Synthesize" run={() => roomAct(props, 'synthesize', 'Asked for a synthesis.')} /><Action icon="sq" label="Stop room" run={() => roomAct(props, 'stop', 'Stopped.')} /><Action icon="trash" label="Delete room" danger run={() => { const id = str(props.id); if (id && window.confirm('Delete this Room?')) void mobileMutation({ mobileOp: 'room.delete', id }, 'Room deleted.').then(() => go({ name: 'rooms' })) }} /></>,
  cwoptions: ({ props }) => <><Title>This Cowork session</Title><DesktopOnly title="Assistant" /><DesktopOnly title="Sampling / parameters" /><DesktopOnly title="Reasoning" sub="Cowork reasoning follows persisted desktop session/model settings." /><DesktopOnly title="Commands & skills" /><Opt title="Tools" lead={<I n="wrench" />} onClick={() => openSheet('tools', props)} /></>,
  attach: () => <><Title>Add to this message</Title><DesktopOnly title="Attachments" sub="Attach files/images from the computer; phone attachment transfer is not enabled." /></>,
  assistant: () => <><Title>Assistant</Title><Opt title="Flint" sub="Default" selected lead={<FlintMark size={26} />} onClick={closeSheet} /><DesktopOnly title="Choose another assistant" /></>,
  params: () => <><Title>Parameters</Title><DesktopOnly title="Output, context, compaction and sampling" /></>,
  skills: () => <><Title>Commands & skills</Title><DesktopOnly title="Commands & skills" sub="Run or configure these on the computer." /></>,
  msgmenu: () => <><Title>Message actions</Title><DesktopOnly title="Additional message actions" sub="Copy is available directly on each assistant message. Edit/regenerate/branch/delete are not exposed remotely." /></>,
  coworkmenu: () => <><Title>Cowork</Title><Action icon="plus" label="New session" run={() => go({ name: 'home', mode: 'cowork' })} /><DesktopOnly title="New group" /><DesktopOnly title="Import session" /></>,
  chatfilter: () => <><Title>Show</Title><Opt title="All" selected onClick={closeSheet} /><DesktopOnly title="Active filter" /></>,
  workspace: ({ props }) => <><Title>Workspace</Title><Kv k="Folder" v={str(props.folder) ?? str(props.group) ?? 'None'} /><DesktopOnly title="Change folder" sub="Changing the workspace of an existing session requires desktop confirmation." />{str(props.folder) && <Action icon="copy" label="Copy path" run={() => void navigator.clipboard?.writeText(str(props.folder)!).then(() => toast('Path copied'), () => toast('Copy failed'))} />}</>,
  temp: () => <><Title>Temporary chat</Title><DesktopOnly title="Temporary chat" sub="Temporary history is not exposed by the current remote protocol." /></>,
  profile: () => <><Title>Work profile</Title><DesktopOnly title="Work profile" sub="Persisted Cowork profiles are selected on the computer." /></>,
  worktree: ({ props }) => <><Title>Session worktree</Title><Kv k="Branch" v={str(props.branch) ?? 'Working copy'} /><Kv k="Path" v={str(props.path) ?? '—'} /><DesktopOnly title="Apply / merge changes" sub="Applying changes to the attached folder requires desktop confirmation." /></>,
  tokens: ({ props }) => <><Title>Token usage</Title><Kv k="Last run" v={typeof props.used === 'number' ? `${props.used.toLocaleString()} tokens` : 'Not reported'} /></>,
}

export function SheetBody({ name, props }: { name: string; props: Props }) {
  const Cmp = SHEETS[name]
  return Cmp ? <Cmp props={props} /> : null
}
