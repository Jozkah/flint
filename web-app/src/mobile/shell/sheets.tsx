import { useMemo, useState, type ReactNode } from 'react'
import type { EffortChoiceWire, NotificationPrefs, RemoteApproval, RemoteModel, ReplyMeta, SessionKind } from '@/lib/remote/protocol'
import { Avatar, Empty, FlintMark, Grab, Kv, Opt, Sw } from '../ui/bits'
import { I, type IconId } from '../ui/icons'
import { act, app, client, closeSheet, go, openDrawer, openSheet, toast, useApp } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { reachLabel, useSessions } from '../state/sessions'
import { respond } from '../ui/respond'
import { usePhonePermissions } from '../ui/hooks'
import { DEFAULT_NOTIFY, forkFrom, regenerateTitleOf, roomAct } from '../state/controls'
import { ContextCard } from '../ui/reply'
import { effortStops, stopLabel } from '../ui/effort'
import { ASSISTANT_ICON } from '../ui/assistants'
import { ACCESS_MODES, COWORK_MODES } from './labels'
import { copyToClipboard } from '@/lib/clipboard'
import { StudioItemSheet, StudioSettingsSheet, VoiceSetupSheet } from './studioSheets'
import type { StudioItemWire } from '@/lib/remote/protocol'
import { addDeskFile, addFiles, attachKey, insertIntoComposer, MAX_FILES } from '../state/attachments'

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
    let result: Record<string, unknown>
    if (raw.mobileOp === 'room.create') {
      result = await client().rpc('room.create', raw.input as never) as unknown as Record<string, unknown>
    } else if (raw.mobileOp === 'room.update') {
      result = await client().rpc('room.update', { id: raw.id, patch: raw.patch } as never) as unknown as Record<string, unknown>
    } else if (raw.mobileOp === 'room.delete') {
      result = await client().rpc('room.delete', { id: raw.id } as never) as unknown as Record<string, unknown>
    } else {
      result = await client().rpc('settings.set', raw as never) as unknown as Record<string, unknown>
    }
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
  const current = str(props.reason) ?? (target === 'home' ? composer.reason : undefined)
  const setReason = (reason: 'auto' | 'on' | 'off', label: string) => {
    if (target === 'home') { app.set((s) => ({ composer: { ...s.composer, reason } })); closeSheet(); toast(label); return }
    if (target === 'chat' && id) { closeSheet(); void act('settings.set', { scope: 'chat', id, reasoning: reason }, label); return }
    if (target === 'room' && id && participant) { closeSheet(); void mobileMutation({ mobileOp: 'room.update', id, patch: { participants: [{ id: participant, reasoning: { mode: reason } }] } }, label) }
  }
  if (target === 'cowork') return <><Title sub="This Cowork session">Reasoning</Title><DesktopOnly title="Reasoning mode" sub="Cowork reasoning is bound to the persisted desktop session/model settings and is read-only on the phone." /></>
  return <><Title>Reasoning</Title>{([['auto','Auto',"Use the model's default."],['on','On','Force reasoning on.'],['off','Off','Disable reasoning.']] as const).map(([v,t,s]) => <Opt key={v} title={t} sub={s} selected={current === v} onClick={() => setReason(v, `Reasoning: ${t}`)} />)}<div className="ssec" /><DesktopOnly title="Reasoning effort / thinking budget" sub="Provider-specific effort and context budgets stay with the persisted desktop model settings." /></>
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
  return <><Title>Stop…</Title>
    <Action icon="sq" label="Stop current task" sub="Ends this response and everything under it. Other sessions keep running." run={() => { if (kind && id) void act('run.stop', { kind, id }, 'Stopped this task.') }} />
    {kind && id && <Action icon="sq" label="Stop all in this chat" danger sub="Ends every run, tool, command and agent in this chat." run={() => { if (window.confirm('Stop all activity in this chat?')) void act('run.stop', { kind, id, scope: 'chat' }).then((r) => { if (r) toast(`Stopped chat activity (${r.stopped} stopped).`) }) }} />}
    <Action icon="alert" label="Stop all activity" danger sub="Ends every run, tool, command and agent everywhere in Flint." run={() => { if (window.confirm('Stop everything?')) void act('run.stop', { all: true }, 'Stopped everything.') }} /></>
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
  return <><Title sub={template ? `Template: ${template}` : 'Configure the room before creating it.'}>New room</Title><label className="field">Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Radar cache TTL" /></label><label className="field">Objective<input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should participants discuss or decide?" /></label><button type="button" className="btn pri big" disabled={!models.data || models.data.models.length < 2} onClick={() => void create()}>Create room</button></>
}

function copyId(props: Props) {
  const id = str(props.id); if (!id) return
  void copyToClipboard(id).then((ok) => toast(ok ? 'ID copied' : 'Copy failed'))
}
function Group({ children }: { children: ReactNode }) {
  return <div className="mgrp">{children}</div>
}
function ThreadMenu({ props }: { props: Props }) {
  const id = str(props.id)
  const rename = () => { if (!id) return; const title = window.prompt('Chat name', str(props.title) ?? ''); if (title?.trim()) void mobileMutation({ mobileOp: 'thread.rename', id, title: title.trim() }, 'Renamed.') }
  const remove = () => { if (id && window.confirm('Delete this chat?')) void mobileMutation({ mobileOp: 'thread.delete', id }, 'Chat deleted.').then(() => go({ name: 'home' })) }
  return <><Title>{str(props.title) ?? 'Chat'}</Title>
    <Group><Action icon="pin" label="Pin" run={() => { if (id) void mobileMutation({ mobileOp: 'thread.pin', id }, 'Updated.') }} /><Action icon="edit" label="Rename" run={rename} /><Action icon="refresh" label="Regenerate title" run={() => { if (id) void regenerateTitleOf('chat', id) }} /></Group>
    <Group><Action icon="fork" label="Fork chat" run={() => { if (id) void forkFrom(id) }} /><DesktopOnly title="Move to group" /></Group>
    <Group><DesktopOnly title="Open in split view" /><Action icon="copy" label="Copy ID" run={() => copyId(props)} /></Group>
    <Group><Action icon="trash" label="Delete" danger run={remove} /></Group></>
}
function SessionMenu({ props }: { props: Props }) {
  const id = str(props.id)
  return <><Title>{str(props.title) ?? 'Cowork session'}</Title>
    <Group><Action icon="file" label="File activity" run={() => openDrawer('right', 'activity')} /><Action icon="refresh" label="Regenerate title" run={() => { if (id) void regenerateTitleOf('cowork', id) }} /><DesktopOnly title="Open in split view" /></Group>
    <Group><DesktopOnly title="Move to group" /><Action icon="fork" label="Fork" run={() => { if (id) void mobileMutation({ mobileOp: 'cowork.fork', id }, 'Forked.').then((r) => { const next = r && typeof r.id === 'string' ? r.id : null; if (next) go({ name: 'cowork', id: next }) }) }} /></Group>
    <Group><Action icon="copy" label="Copy ID" run={() => copyId(props)} /><DesktopOnly title="Export" /><DesktopOnly title="Hand off" /></Group>
    <Group><Action icon="trash" label="Delete" danger run={() => { if (id && window.confirm('Delete this Cowork session?')) void mobileMutation({ mobileOp: 'cowork.delete', id }, 'Session deleted.').then(() => go({ name: 'home' })) }} /></Group></>
}
function RoomMenu({ props }: { props: Props }) {
  const id = str(props.id)
  return <><Title>{str(props.title) ?? 'Room'}</Title>
    <Group><Action icon="pause" label="Pause" run={() => roomAct(props, 'pause', 'Paused.')} /><Action icon="play" label="Resume" run={() => roomAct(props, 'resume', 'Resumed.')} /><Action icon="vote" label="Call vote" run={() => openSheet('vote', props)} /><Action icon="file" label="Synthesize" run={() => roomAct(props, 'synthesize', 'Asked for a synthesis.')} /><Action icon="sq" label="Stop room" run={() => roomAct(props, 'stop', 'Stopped.')} /></Group>
    <Group><DesktopOnly title="Open in split view" /><DesktopOnly title="Move to group" /><Action icon="refresh" label="Regenerate title" run={() => { if (id) void regenerateTitleOf('room', id) }} /></Group>
    <Group><button type="button" className="opt" onClick={() => openSheet('clearroom', props)}><I n="erase" /><span className="tx"><b>Clear this room…</b></span></button><Action icon="trash" label="Delete" danger run={() => { if (id && window.confirm('Delete this Room?')) void mobileMutation({ mobileOp: 'room.delete', id }, 'Room deleted.').then(() => go({ name: 'rooms' })) }} /></Group></>
}
function ClearRoomSheet({ props }: { props: Props }) {
  const id = str(props.id)
  const [scope, setScope] = useState<'chat' | 'knowledge' | 'everything'>('chat')
  return <><Title>Clear this room</Title>
    <Opt title="Chat only" sub="Every message, vote and synthesis. Keeps what participants learned." selected={scope === 'chat'} onClick={() => setScope('chat')} />
    <Opt title="Chat and knowledge" sub="Also the run counters and round, so it starts over from the objective." selected={scope === 'knowledge'} onClick={() => setScope('knowledge')} />
    <Opt title="Everything, including cache" sub="Also its scratch workspaces." selected={scope === 'everything'} onClick={() => setScope('everything')} />
    <button type="button" className="btn dan big" disabled={!id} onClick={() => { closeSheet(); if (id) void act('room.clear', { id, scope }, 'Room cleared.').then(() => invalidate(['rooms.get', 'thread.messages'])) }}>Clear</button></>
}

function Chevron() {
  return <I n="chevr" style={{ color: 'var(--muted-foreground)' }} />
}
function Go({ icon, lead, title, sub, sheet, props }: { icon?: IconId; lead?: ReactNode; title: string; sub?: ReactNode; sheet: string; props?: Props }) {
  return <button type="button" className="opt" onClick={() => openSheet(sheet, props)}>{lead ?? (icon && <I n={icon} />)}<span className="tx"><b>{title}</b>{sub && <small>{sub}</small>}</span><Chevron /></button>
}

/** The composer's "+" (#76): what to add, then the options. */
function PlusSheet({ props }: { props: Props }) {
  const target = str(props.for) ?? 'home'
  const id = str(props.id)
  const cowork = target === 'cowork'
  const settings = useRpc('settings.get', {})
  const tools = useRpc('tools.list', {})
  const details = useRpc('chat.details', { id: id ?? '' }, target === 'chat' && Boolean(id))
  const homeWeb = useApp((s) => s.composer.web)
  const web = target === 'home' ? homeWeb : (settings.data?.webSearch.enabled ?? false)
  const provider = settings.data?.webSearchProviders?.find((p) => p.id === settings.data?.webSearch.provider)?.name ?? settings.data?.webSearch.provider ?? 'Web'
  const toggleWeb = () => {
    if (target === 'home') { app.set((s) => ({ composer: { ...s.composer, web: !s.composer.web } })); return }
    void act('settings.set', { key: 'webSearch', value: !web }, !web ? 'Web search on' : 'Web search off').then(() => invalidate(['settings.get']))
  }
  const active = (tools.data?.servers ?? []).filter((x) => x.active).length
  const d = details.data
  const key = attachKey({ for: target === 'chat' || target === 'cowork' ? target : 'home', id })
  const pick = (files: FileList | null) => {
    closeSheet()
    if (files?.length) void addFiles(key, Array.from(files))
  }
  const computer = useApp((s) => s.computerName) ?? 'the computer'
  const deskNote = cowork && id ? undefined : 'Cowork sessions only: they have a folder'
  return <><Title>Add</Title>
    <FilePick icon="image" label="Photo library" accept="image/*" multiple onPick={pick} testId="add-photos" />
    <FilePick icon="camera" label="Take photo" accept="image/*" capture="environment" onPick={pick} testId="add-camera" />
    <FilePick icon="file" label="Add files" sub={`Up to ${MAX_FILES} per message`} multiple onPick={pick} testId="add-files" />
    <button type="button" className="opt" disabled={!!deskNote} aria-disabled={!!deskNote} onClick={() => openSheet('files', { id, pick: 'attach', key })} data-testid="add-desk"><I n="folder" /><span className="tx"><b>Files on {computer}</b><small>{deskNote ?? 'Browse the session folder (read-only)'}</small></span></button>
    <button type="button" className="opt" disabled={!!deskNote} aria-disabled={!!deskNote} onClick={() => openSheet('files', { id, pick: 'ref', key })} data-testid="add-ref"><I n="at" /><span className="tx"><b>Reference a file (@)</b><small>{deskNote ?? 'Inserts @path into the message'}</small></span></button>
    <div className="ssec">Options</div>
    <Go lead={<FlintMark size={26} />} title="Assistant" sub={cowork ? 'Flint' : d ? (d.assistant.auto ? 'Auto · Jev picks per turn' : d.assistant.name) : 'Auto · Jev picks per turn'} sheet="assistant" props={props} />
    <Go icon="sliders" title="Sampling" sub="Defaults from the model" sheet="params" />
    <Go icon="wrench" title="Tools" sub={tools.data ? `${active} enabled` : undefined} sheet="tools" />
    <button type="button" className={`row${web ? ' on' : ''}`} style={{ padding: '9px 10px' }} aria-pressed={web} onClick={toggleWeb} data-testid="plus-web"><I n="globe" /><span className="tx"><b>Web search</b><small>{provider}</small></span><Sw on={web} /></button>
    {target === 'chat' && d?.effort
      ? <Go icon="bulb" title="Reasoning" sub="Effort is under the composer" sheet="effort" props={{ id }} />
      : <Go icon="bulb" title="Reasoning" sheet="reason" props={{ for: target, id }} />}
    {cowork && <Go icon="slash" title="Commands & skills" sheet="skills" />}</>
}

/** ComposerEffort's bar: Faster ↔ Smarter, Off only where the model can stop thinking. */
function EffortSheet({ props }: { props: Props }) {
  const id = str(props.id) ?? ''
  const { data } = useRpc('chat.details', { id }, Boolean(id))
  const e = data?.effort
  if (!e) return <><Title>Effort</Title><p className="sh">This model sizes its own thinking.</p></>
  const { stops, shown } = effortStops(e)
  const i = Math.max(0, stops.indexOf(shown))
  const at = stops.length > 1 ? i / (stops.length - 1) : 0
  const choose = (choice: EffortChoiceWire | null, label: string) => void act('chat.effort', { id, choice }, label).then(() => invalidate(['chat.details']))
  return <><Grab />
    <div className="kv" style={{ background: 'none', border: 0, padding: 0 }}><h3>Effort</h3>{e.overridden && <button type="button" className="btn sm ghost" onClick={() => choose(null, 'Effort reset')}>Reset</button>}</div>
    <div className="kv" style={{ background: 'none', border: 0, padding: 0, fontSize: 12 }}><span>Faster</span><span>Smarter</span></div>
    <div className="etrack" role="radiogroup" aria-label="Effort">
      {stops.map((x, j) => <button key={x} type="button" role="radio" aria-checked={j === i} className="estop" aria-label={stopLabel(x)} onClick={() => choose(x, `Effort: ${stopLabel(x)}`)}><i /></button>)}
      <span className="ethumb" style={{ left: `calc(${at * 100}% - ${at * 28}px)` }} />
    </div>
    <div className="elabels">{stops.map((x) => <span key={x}>{stopLabel(x)}{x === e.recommended && <small>Recommended</small>}</span>)}</div>
    <p className="sh">{e.canDisable ? `${data?.model?.name ?? 'This model'} can turn thinking off. ` : ''}Applies to this chat.</p></>
}

/** The context ring's card, and the last reply's figures. */
function TokensSheet({ props }: { props: Props }) {
  const target = str(props.for) ?? 'home'
  const id = str(props.id) ?? ''
  const details = useRpc('chat.details', { id }, target === 'chat' && Boolean(id))
  const cowork = useRpc('cowork.get', { id }, target === 'cowork' && Boolean(id))
  const msgs = useRpc('thread.messages', { id, kind: 'chat', limit: 100 }, target === 'chat' && Boolean(id))
  const d = details.data
  const last = [...(msgs.data?.messages ?? [])].reverse().find((m) => m.role === 'assistant')?.meta
  const compactNow = d?.canCompact
    ? () => { closeSheet(); app.set((s) => ({ compacting: { ...s.compacting, [id]: true } })); void act('chat.compact', { id }, 'Compacting the conversation…') }
    : undefined
  if (target === 'cowork') {
    const u = cowork.data?.usage
    const c = cowork.data?.context
    return <><Title>Context</Title>{c?.windowTokens ? <Kv k="Context window" v={`${c.usedTokens.toLocaleString()} of ${c.windowTokens.toLocaleString()} tokens (${Math.round((c.usedTokens / c.windowTokens) * 100)}%)`} /> : null}{u ? <><Kv k="Input" v={`${u.inputTokens.toLocaleString()} tokens`} /><Kv k="Output" v={`${u.outputTokens.toLocaleString()} tokens`} /></> : <p className="sh">Nothing sent yet.</p>}<DesktopOnly title="Compact session" sub="Cowork sessions compact on the computer." /></>
  }
  if (target !== 'chat') return <><Title>Context</Title><ContextCard c={null} /></>
  return <><Title>Context</Title><ContextCard c={d?.context ?? null} speed={d?.speed} onCompact={compactNow} />
    {last && <><div className="ssec">Last reply</div>
      {last.tokensPerSecond ? <Kv k="Generation" v={`${last.tokensPerSecond.toFixed(1)} t/s`} /> : null}
      {last.promptPerSecond ? <Kv k="Reading" v={`${last.promptPerSecond.toFixed(0)} t/s`} /> : null}
      {last.draft ? <Kv k="Draft accepted" v={`${Math.round((last.draft.accepted / last.draft.tokens) * 100)}% of ${last.draft.tokens}`} /> : null}
      {last.cache ? <Kv k="Prompt cache" v={last.cache === 'reused' ? 'Cache reused' : 'Not reused'} /> : null}</>}
    {d && !d.canCompact && <DesktopOnly title="Compact session" sub="Open the chat on the computer to compact it." />}</>
}

function ReplyStatsSheet({ props }: { props: Props }) {
  const m = props.meta as ReplyMeta | undefined
  return <><Title>Last reply</Title>
    {m?.tokensPerSecond ? <Kv k="Generation" v={`${m.tokensPerSecond.toFixed(1)} t/s`} /> : null}
    {m?.promptPerSecond ? <Kv k="Reading" v={`${m.promptPerSecond.toFixed(0)} t/s`} /> : null}
    {m?.outputTokens ? <Kv k="Tokens" v={m.outputTokens.toLocaleString()} /> : null}
    {m?.cache ? <Kv k="Prompt cache" v={m.cache === 'reused' ? 'Cache reused' : 'Not reused'} /> : null}
    {m?.draft ? <Kv k="Draft accepted" v={`${Math.round((m.draft.accepted / m.draft.tokens) * 100)}% of ${m.draft.tokens}`} /> : null}
    {m?.model ? <Kv k="Model" v={<span className="mono">{m.model}</span>} /> : null}</>
}

function SkillsUsedSheet({ props }: { props: Props }) {
  const skills = Array.isArray(props.skills) ? (props.skills as string[]) : []
  return <><Title>Used {skills.length} {skills.length === 1 ? 'skill' : 'skills'}</Title>
    {skills.map((name) => { const [plugin, skill] = name.includes(':') ? name.split(':', 2) : [null, name]; return <div key={name} className="opt"><span className="tx"><b>{plugin && <span className="muted">{plugin}:</span>}{skill}</b></span></div> })}</>
}

const ASSISTANT_SUB: Record<string, string> = { jan: 'Default', quartz: 'Code and review', coal: 'Research and reading', blaze: 'Writing and drafts', redstone: 'Automation and tools' }
/** The assistant picker (#47): Auto lets Jev route each turn, else Flint. */
function AssistantSheet({ props }: { props: Props }) {
  const target = str(props.for) ?? 'home'
  const id = str(props.id)
  const list = useRpc('assistants.list', {})
  const details = useRpc('chat.details', { id: id ?? '' }, target === 'chat' && Boolean(id))
  if (target !== 'chat' || !id) {
    return <><Title>Assistant</Title><Opt title="Flint" sub={target === 'cowork' ? 'This Cowork session' : 'Auto · Jev picks per turn once the chat starts'} selected lead={<FlintMark size={26} />} onClick={closeSheet} /><DesktopOnly title="Choose another assistant" sub={target === 'cowork' ? 'Cowork assistants are chosen on the computer.' : 'Pick one in the chat after sending the first message.'} /></>
  }
  const cur = details.data?.assistant
  const pick = (assistant: string, label: string) => { closeSheet(); void act('chat.assistant', { id, assistant }, label).then(() => invalidate(['chat.details'])) }
  const all = list.data?.assistants ?? []
  return <><Title>Assistant</Title>
    <Opt title="Auto" sub={list.data?.routing === false ? 'Automatic routing is off in Settings › Jev' : 'Jev routes each turn to the right assistant, else Flint'} selected={Boolean(cur?.auto)} lead={<span className="pico"><I n="wand" /></span>} onClick={() => pick('auto', 'Assistant: Auto')} />
    {all.map((a) => { const icon = ASSISTANT_ICON[a.name]; return <Opt key={a.id} title={a.name} sub={a.description || ASSISTANT_SUB[a.id]} selected={!cur?.auto && cur?.id === a.id} lead={a.id === 'jan' ? <FlintMark size={26} /> : <span className="pico" style={icon ? { color: icon[1] } : undefined}><I n={icon?.[0] ?? 'sparkles'} /></span>} onClick={() => pick(a.id, `Assistant: ${a.name}`)} /> })}
    <Go icon="sliders" title="Parameters" sheet="params" /></>
}

function MsgMenu({ props }: { props: Props }) {
  const id = str(props.id)
  const messageId = str(props.messageId)
  const text = str(props.text) ?? ''
  return <><Title>Message actions</Title>
    <Action icon="copy" label="Copy" run={() => void navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed'))} />
    <Action icon="fork" label="Fork chat from here" run={() => { if (id) void forkFrom(id, messageId) }} />
    <DesktopOnly title="Edit, regenerate or delete" sub="These change the conversation on the computer." /></>
}

function ModelGoneSheet({ props }: { props: Props }) {
  const id = str(props.id)
  return <><Title sub={`${str(props.name) ?? 'The model'} was removed from the computer.`}>A model is no longer available</Title>
    <Opt title="This chat" sub="Choose a model to continue" selected onClick={() => openSheet('model', { for: 'chat', id })} />
    <button type="button" className="btn pri big" onClick={() => openSheet('model', { for: 'chat', id })}>Choose a model</button></>
}

/** The Code tab's project explorer: the session folder, a level at a time. */
/** A row that opens the phone's file picker (or camera). */
function FilePick({ icon, label, sub, accept, capture, multiple, onPick, testId }: { icon: IconId; label: string; sub?: string; accept?: string; capture?: 'environment' | 'user'; multiple?: boolean; onPick: (f: FileList | null) => void; testId: string }) {
  return <label className="opt" data-testid={testId}><I n={icon} /><span className="tx"><b>{label}</b>{sub && <small>{sub}</small>}</span>
    <input type="file" hidden accept={accept} capture={capture} multiple={multiple} onChange={(e) => { onPick(e.target.files); e.target.value = '' }} /></label>
}

function FilesSheet({ props }: { props: Props }) {
  const id = str(props.id) ?? ''
  const pickMode = str(props.pick)
  const key = str(props.key) ?? `cowork:${id}`
  const [path, setPath] = useState(str(props.path) ?? '')
  const { data, error, loading } = useRpc('cowork.files', { id, path }, Boolean(id))
  const open = (rel: string) => {
    if (pickMode === 'attach') { addDeskFile(key, rel); closeSheet(); return }
    if (pickMode === 'ref') { insertIntoComposer(key, `@${rel}`); closeSheet(); return }
    const cur = app.get().code[id] ?? { open: [], active: null }
    app.set((s) => ({ code: { ...s.code, [id]: { open: cur.open.includes(rel) ? cur.open : [...cur.open, rel], active: rel } } }))
    closeSheet()
    openDrawer('right', 'code')
  }
  const up = path.split('/').slice(0, -1).join('/')
  return <><Title sub={data?.root ?? undefined}>{pickMode === 'attach' ? 'Attach a file' : pickMode === 'ref' ? 'Reference a file' : 'Project explorer'}</Title>
    {path && <Opt title=".." sub={path} lead={<I n="back" />} onClick={() => setPath(up)} />}
    {loading && !data && <p className="sh">Loading…</p>}
    {error && <p className="sh">{error.message}</p>}
    {data && !data.root && <p className="sh">This session has no folder.</p>}
    {data?.entries.map((e) => <Opt key={e.relPath} title={e.name} lead={<I n={e.isDir ? 'folder' : 'file'} />} onClick={() => (e.isDir ? setPath(e.relPath) : open(e.relPath))} />)}
    {data?.truncated && <p className="sh">More files are in this folder than the phone lists.</p>}</>
}

const SHEETS: Record<string, (p: { props: Props }) => ReactNode> = {
  model: ModelSheet, reason: ReasonSheet, mode: ModeSheet, access: AccessSheet, stop: StopSheet, permdetails: PermDetailsSheet, vote: VoteSheet, runs: RunsSheet, conn: ConnSheet, palette: PaletteSheet, notifset: NotifSetSheet, tools: ToolsSheet, roomnew: RoomNewSheet, threadmenu: ThreadMenu, sessmenu: SessionMenu, roommenu: RoomMenu, clearroom: ClearRoomSheet, plus: PlusSheet, attach: PlusSheet, cwoptions: PlusSheet, effort: EffortSheet, tokens: TokensSheet, replystats: ReplyStatsSheet, skillsused: SkillsUsedSheet, assistant: AssistantSheet, msgmenu: MsgMenu, modelgone: ModelGoneSheet, files: FilesSheet,
  studioset: () => <StudioSettingsSheet />, studioitem: ({ props }) => <StudioItemSheet item={props.item as StudioItemWire | undefined} />, voicesetup: () => <VoiceSetupSheet />,
  params: () => <><Title>Parameters</Title><DesktopOnly title="Output, context, compaction and sampling" /></>,
  skills: () => <><Title>Commands & skills</Title><DesktopOnly title="Commands & skills" sub="Run or configure these on the computer." /></>,
  coworkmenu: () => <><Title>Cowork</Title><Action icon="plus" label="New session" run={() => go({ name: 'home', mode: 'cowork' })} /><DesktopOnly title="New group" /><DesktopOnly title="Import session" /></>,
  chatfilter: () => <><Title>Show</Title><Opt title="All" selected onClick={closeSheet} /><DesktopOnly title="Active filter" /></>,
  workspace: ({ props }) => <><Title>Workspace</Title><Kv k="Folder" v={str(props.folder) ?? str(props.group) ?? 'None'} /><DesktopOnly title="Change folder" sub="Changing an existing session workspace requires desktop confirmation." />{str(props.folder) && <Action icon="copy" label="Copy path" run={() => void copyToClipboard(str(props.folder)!).then((ok) => toast(ok ? 'Path copied' : 'Copy failed'))} />}</>,
  temp: () => <><Title>Temporary chat</Title><DesktopOnly title="Temporary chat" sub="Temporary history is not exposed by the current remote protocol." /></>,
  profile: () => <><Title>Work profile</Title><DesktopOnly title="Work profile" sub="Persisted Cowork profiles are selected on the computer." /></>,
  worktree: ({ props }) => <><Title>Session worktree</Title><Kv k="Branch" v={str(props.branch) ?? 'Working copy'} /><Kv k="Path" v={str(props.path) ?? '—'} /><DesktopOnly title="Apply / merge changes" sub="Applying changes to the attached folder requires desktop confirmation." /></>,
}
export function SheetBody({ name, props }: { name: string; props: Props }) {
  const Cmp = SHEETS[name]
  return Cmp ? <Cmp props={props} /> : null
}
