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
import type { ArchiveItemWire, StudioItemWire } from '@/lib/remote/protocol'
import { archiveChanged } from '../state/archive'
import { addDeskFile, addFiles, attachKey, insertIntoComposer, MAX_FILES } from '../state/attachments'
import { t } from '../i18n'

type Props = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const participantId = (p: Props) => str(p.participant)

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return <><Grab /><h3>{children}</h3>{sub && <p className="sh">{sub}</p>}</>
}
function DesktopOnly({ title, sub = t('sheets.availableOnComputer') }: { title: ReactNode; sub?: ReactNode }) {
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
    toast(e instanceof Error ? e.message : t('sheets.actionFailed'))
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
      closeSheet(); toast(t('sheets.switchedTo', { name: m.name })); return
    }
    if ((target === 'chat' || target === 'cowork') && id) {
      closeSheet(); void act('settings.set', { scope: target, id, model: { id: m.id, provider: m.provider } }, t('sheets.switchedTo', { name: m.name })).then(() => invalidate(['cowork.get', 'sessions.list'])); return
    }
    if (target === 'room' && id && participant) {
      closeSheet(); void mobileMutation({ mobileOp: 'room.update', id, patch: { participants: [{ id: participant, model: { id: m.id, provider: m.provider } }] } }, t('sheets.switchedTo', { name: m.name }))
    }
  }
  return <><Title>{t('chat.model')}</Title><div className="sin"><I n="search" /><input placeholder={t('sheets.searchModels')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('sheets.searchModelsLabel')} /></div>{loading && !data && <p className="sh">{t('sheets.loadingModels')}</p>}{models.map((m) => <Opt key={`${m.provider}/${m.id}`} title={m.name} sub={`${m.providerName ?? m.provider}${m.local ? ` · ${t('sheets.runsHere')}` : ''}${m.loaded ? ` · ${t('models.loaded')}` : ''}`} selected={target === 'home' && current?.id === m.id && current.provider === m.provider} lead={<Avatar id={m.id} name={m.name} provider={m.provider} size={28} square />} onClick={() => pick(m)} />)}{data && models.length === 0 && <p className="sh">{t('huggingface.noMatch')}</p>}<div className="ssec" /><DesktopOnly title={t('sheets.parameters')} sub={t('sheets.parametersSub')} /></>
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
  if (target === 'cowork') return <><Title sub={t('sheets.thisCowork')}>{t('room.reasoning')}</Title><DesktopOnly title={t('sheets.reasoningMode')} sub={t('sheets.reasoningModeSub')} /></>
  return <><Title>{t('room.reasoning')}</Title>{([['auto', t('chat.auto'), t('sheets.reasonAutoSub')], ['on', t('common.on'), t('sheets.reasonOnSub')], ['off', t('common.off'), t('sheets.reasonOffSub')]] as const).map(([v, label, hint]) => <Opt key={v} title={label} sub={hint} selected={current === v} onClick={() => setReason(v, t('sheets.reasoningLabel', { label }))} />)}<div className="ssec" /><DesktopOnly title={t('sheets.effortBudget')} sub={t('sheets.effortBudgetSub')} /></>
}

function ModeSheet({ props }: { props: Props }) {
  const current = str(props.value) ?? app.get().composer.cwMode
  const id = str(props.id)
  return <><Title>{t('home.mayDo')}</Title>{COWORK_MODES.map((m) => <Opt key={m.id} title={m.label} sub={m.sub} selected={current === m.id} onClick={() => { closeSheet(); if (!id) app.set((s) => ({ composer: { ...s.composer, cwMode: m.id } })); else void act('settings.set', { scope: 'cowork', id, mode: m.id }, m.label).then(() => invalidate(['cowork.get'])) }} />)}</>
}

function AccessSheet({ props }: { props: Props }) {
  const current = str(props.value) ?? app.get().composer.access
  const id = str(props.id)
  return <><Title sub={t('sheets.writeAccessSub')}>{t('home.changesGo')}</Title>{ACCESS_MODES.map((m) => m.id === 'review-only' ? <Opt key={m.id} title={m.label} sub={m.sub} selected={current === m.id} onClick={() => { closeSheet(); if (!id) app.set((s) => ({ composer: { ...s.composer, access: m.id } })); else void act('settings.set', { scope: 'cowork', id, access: m.id }, t('sheets.reviewOnly')).then(() => invalidate(['cowork.get'])) }} /> : <DesktopOnly key={m.id} title={m.label} sub={t('sheets.confirmRequired', { sub: m.sub })} />)}</>
}

function StopSheet({ props }: { props: Props }) {
  const kind = str(props.kind) as SessionKind | undefined
  const id = str(props.id)
  return <><Title>{t('composer.stop')}</Title>
    <Action icon="sq" label={t('sheets.stopTask')} sub={t('sheets.stopTaskSub')} run={() => { if (kind && id) void act('run.stop', { kind, id }, t('sheets.stoppedTask')) }} />
    {kind && id && <Action icon="sq" label={t('sheets.stopChat')} danger sub={t('sheets.stopChatSub')} run={() => { if (window.confirm(t('sheets.stopChatConfirm'))) void act('run.stop', { kind, id, scope: 'chat' }).then((r) => { if (r) toast(t('sheets.stoppedChat', { count: r.stopped })) }) }} />}
    <Action icon="alert" label={t('sheets.stopAll')} danger sub={t('sheets.stopAllSub')} run={() => { if (window.confirm(t('sheets.stopAllConfirm'))) void act('run.stop', { all: true }, t('sheets.stoppedAll')) }} /></>
}

function PermDetailsSheet({ props }: { props: Props }) {
  const a = props.approval as RemoteApproval | undefined
  const perms = usePhonePermissions()
  if (!a) return <Title>{t('approval.details')}</Title>
  return <><Title sub={t('sheets.permScope')}>{t('approval.details')}</Title><div className="scopes">{a.scopes.filter((s) => s.scope !== 'always' || perms.alwaysAllow).map((s, i) => <button key={s.scope} type="button" className={`scope${i === 0 ? ' sug' : ''}`} disabled={!perms.approvals} onClick={() => { closeSheet(); void respond(a, 'allow', s.scope, s.label) }}><b>{s.label}{s.broader && <span className="broader">● {t('sheets.broader')}</span>}</b><small>{perms.approvals ? s.explanation : t('sheets.approvalsDisabled')}</small></button>)}</div><div className="ssec">{t('sheets.technical')}</div><Kv k={t('sheets.tool')} v={<span className="mono">{a.toolName}</span>} /><Kv k={t('sheets.server')} v={a.serverName ?? t('sheets.builtIn')} /><div className="cmd">{a.argumentsJson}</div></>
}

function RunsSheet() {
  const { data } = useRpc('status', {})
  const { sessions } = useSessions()
  return <><Title>{t('sheets.runs')}</Title>{(data?.runs ?? []).length === 0 && <p className="sh">{t('sheets.nothingRunning')}</p>}{(data?.runs ?? []).map((r) => { const s = sessions.find((x) => x.id === r.id); return <Opt key={`${r.kind}:${r.id}`} title={s?.title ?? t('common.untitled')} sub={t('sheets.runningKind', { kind: r.kind === 'room' ? t('room.crumb') : r.kind === 'cowork' ? t('home.modes.cowork') : t('home.modes.chat') })} lead={<FlintMark size={28} />} onClick={() => go({ name: r.kind, id: r.id })} /> })}</>
}

function ConnSheet() {
  const computer = useApp((s) => s.computerName) ?? t('common.yourComputerCap')
  const conn = useApp((s) => s.conn)
  const status = useRpc('status', {})
  const sys = useRpc('system.info', {})
  return <><Title>{t('sheets.computers')}</Title><Opt title={computer} sub={t('sheets.connLine', { conn, via: reachLabel(), count: status.data?.modelsLoaded ?? 0 })} selected lead={<I n="monitor" />} /><Kv k={t('sheets.route')} v={<span className="mono">{location.host}</span>} /><Kv k={t('settings.computer.localApi')} v={sys.data ? (sys.data.localApi.running ? t('common.on') : t('common.off')) : '—'} /><Action icon="monitor" label={t('system.title')} run={() => go({ name: 'system' })} /><Action icon="settings" label={t('settings.rows.remote')} run={() => go({ name: 'remote' })} /></>
}

function PaletteSheet() {
  const [q, setQ] = useState('')
  const { sessions } = useSessions()
  const hits = useMemo(() => (q ? sessions.filter((s) => s.title.toLowerCase().includes(q.toLowerCase())) : sessions).slice(0, 12), [q, sessions])
  return <><Grab /><div className="sin"><I n="search" /><input placeholder={t('sheets.palettePlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div><Opt title={t('home.title')} lead={<I n="pen" />} onClick={() => go({ name: 'home', mode: 'chat' })} /><Opt title={t('sheets.newCowork')} lead={<I n="cowork" />} onClick={() => go({ name: 'home', mode: 'cowork' })} /><Opt title={t('rooms.title')} lead={<I n="rooms" />} onClick={() => go({ name: 'rooms' })} /><div className="ssec">{t('sheets.conversations')}</div>{hits.map((s) => <Opt key={s.id} title={s.title || t('common.untitled')} sub={s.group} onClick={() => go({ name: s.kind, id: s.id })} />)}</>
}

function VoteSheet({ props }: { props: Props }) {
  const [proposal, setProposal] = useState('')
  const id = str(props.id)
  return <><Title sub={t('sheets.voteSub')}>{t('sheets.callVote')}</Title><label className="field">{t('sheets.proposal')}<input value={proposal} onChange={(e) => setProposal(e.target.value)} /></label><button type="button" className="btn pri big" disabled={!proposal.trim() || !id} onClick={() => { closeSheet(); if (id) void act('room.control', { id, action: 'vote', proposal: proposal.trim() }, t('sheets.voteCalled')) }}>{t('rightpanel.callVote')}</button></>
}

const NOTIFY_ROWS: [keyof NotificationPrefs, string][] = [['approvals', t('push.types.approvals')], ['runFinished', t('push.types.runFinished')], ['errors', t('push.types.runFailed')], ['roomTurns', t('push.types.roomWaiting')]]
function NotifSetSheet() {
  const { data } = useRpc('settings.get', {})
  const prefs = data?.notifications ?? DEFAULT_NOTIFY
  return <><Title>{t('push.notifyWhen')}</Title>{NOTIFY_ROWS.map(([k,label]) => <button key={k} type="button" className={`row${prefs[k] ? ' on' : ''}`} onClick={() => void act('settings.set', { key: 'notifications', value: { ...prefs, [k]: !prefs[k] } }).then(() => invalidate(['settings.get']))}><span className="tx"><b>{label}</b></span><Sw on={prefs[k]} /></button>)}</>
}

function ToolsSheet() {
  const { data } = useRpc('tools.list', {})
  return <><Title>{t('sheets.availableTools')}</Title>{(data?.servers ?? []).map((s) => <div key={s.name} className="opt" aria-disabled="true"><I n="wrench" /><span className="tx"><b>{s.name}</b><small>{t('sheets.toolState', { state: s.active ? t('common.on') : t('common.off') })}</small></span></div>)}{data && data.servers.length === 0 && <Empty>{t('sheets.noMcp')}</Empty>}</>
}

const TEMPLATE_NAME: Record<string, string> = {
  'Architecture review': 'home.templates.architecture.name',
  Naming: 'home.templates.naming.name',
  'Cross-check': 'home.templates.crossCheck.name',
  Debate: 'home.templates.debate.name',
}

function RoomNewSheet({ props }: { props: Props }) {
  const models = useRpc('models.list', {})
  const template = str(props.template)
  const templateName = template ? (TEMPLATE_NAME[template] ? t(TEMPLATE_NAME[template]) : template) : ''
  const [title, setTitle] = useState(templateName)
  const [objective, setObjective] = useState('')
  const create = async () => {
    const choices = models.data?.models ?? []
    if (choices.length < 2) { toast(t('sheets.needTwoModels')); return }
    const count = template === 'Cross-check' || template === 'Debate' ? 2 : Math.min(3, choices.length)
    const picked = choices.slice(0, count)
    const moderator = template === 'Architecture review' || template === 'Debate'
    closeSheet()
    const result = await mobileMutation({ mobileOp: 'room.create', input: { title: title.trim() || templateName || t('home.newRoom'), objective: objective.trim(), mode: 'round-robin', participants: picked.map((m,i) => ({ name: m.name || t('home.participant', { n: i + 1 }), role: i === 0 ? 'proposer' : i === 1 ? 'reviewer' : 'cross-checker', model: { id: m.id, provider: m.provider }, toolAccess: 'none' })), moderator: { enabled: moderator, ...(moderator ? { model: { id: picked[0].id, provider: picked[0].provider } } : {}) } } })
    const id = result && typeof result.id === 'string' ? result.id : null
    if (id) go({ name: 'room', id })
  }
  return <><Title sub={template ? t('sheets.template', { name: templateName }) : t('sheets.configureRoom')}>{t('home.newRoom')}</Title><label className="field">{t('sheets.titleField')}<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('sheets.titlePlaceholder')} /></label><label className="field">{t('room.objective')}<input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder={t('sheets.objectivePlaceholder')} /></label><button type="button" className="btn pri big" disabled={!models.data || models.data.models.length < 2} onClick={() => void create()}>{t('sheets.createRoom')}</button></>
}

function copyId(props: Props) {
  const id = str(props.id); if (!id) return
  void copyToClipboard(id).then((ok) => toast(ok ? t('sheets.idCopied') : t('common.copyFailed')))
}
function Group({ children }: { children: ReactNode }) {
  return <div className="mgrp">{children}</div>
}
function ThreadMenu({ props }: { props: Props }) {
  const id = str(props.id)
  const rename = () => { if (!id) return; const title = window.prompt(t('sheets.chatName'), str(props.title) ?? ''); if (title?.trim()) void mobileMutation({ mobileOp: 'thread.rename', id, title: title.trim() }, t('sheets.renamed')) }
  const remove = () => { if (id && window.confirm(t('sheets.deleteChatConfirm'))) void mobileMutation({ mobileOp: 'thread.delete', id }, t('sheets.chatDeleted')).then(() => go({ name: 'home' })) }
  return <><Title>{str(props.title) ?? t('chat.untitled')}</Title>
    <Group><Action icon="pin" label={t('sheets.pin')} run={() => { if (id) void mobileMutation({ mobileOp: 'thread.pin', id }, t('sheets.updated')) }} /><Action icon="edit" label={t('sheets.rename')} run={rename} /><Action icon="refresh" label={t('sheets.regenerateTitle')} run={() => { if (id) void regenerateTitleOf('chat', id) }} /></Group>
    <Group><Action icon="fork" label={t('sheets.forkChat')} run={() => { if (id) void forkFrom(id) }} /><DesktopOnly title={t('sheets.moveToGroup')} /></Group>
    <Group><DesktopOnly title={t('sheets.splitView')} /><Action icon="copy" label={t('sheets.copyId')} run={() => copyId(props)} /></Group>
    <Group><Action icon="trash" label={t('common.delete')} danger run={remove} /></Group></>
}
function SessionMenu({ props }: { props: Props }) {
  const id = str(props.id)
  return <><Title>{str(props.title) ?? t('cowork.untitled')}</Title>
    <Group><Action icon="file" label={t('sheets.fileActivity')} run={() => openDrawer('right', 'activity')} /><Action icon="edit" label={t('sheets.rename')} run={() => { if (!id) return; const title = window.prompt(t('sheets.sessionName'), str(props.title) ?? ''); if (title?.trim()) void mobileMutation({ mobileOp: 'cowork.rename', id, title: title.trim() }, t('sheets.renamed')) }} /><Action icon="refresh" label={t('sheets.regenerateTitle')} run={() => { if (id) void regenerateTitleOf('cowork', id) }} /><DesktopOnly title={t('sheets.splitView')} /></Group>
    <Group><DesktopOnly title={t('sheets.moveToGroup')} /><Action icon="fork" label={t('sheets.fork')} run={() => { if (id) void mobileMutation({ mobileOp: 'cowork.fork', id }, t('sheets.forked')).then((r) => { const next = r && typeof r.id === 'string' ? r.id : null; if (next) go({ name: 'cowork', id: next }) }) }} /></Group>
    <Group><Action icon="copy" label={t('sheets.copyId')} run={() => copyId(props)} /><DesktopOnly title={t('sheets.export')} /><DesktopOnly title={t('sheets.handOff')} /></Group>
    <Group><Action icon="trash" label={t('common.delete')} danger run={() => { if (id && window.confirm(t('sheets.deleteSessionConfirm'))) void mobileMutation({ mobileOp: 'cowork.delete', id }, t('sheets.sessionDeleted')).then(() => go({ name: 'home' })) }} /></Group></>
}
function RoomMenu({ props }: { props: Props }) {
  const id = str(props.id)
  return <><Title>{str(props.title) ?? t('room.crumb')}</Title>
    <Group><Action icon="pause" label={t('rightpanel.pause')} run={() => roomAct(props, 'pause', t('rightpanel.paused'))} /><Action icon="play" label={t('rightpanel.resume')} run={() => roomAct(props, 'resume', t('rightpanel.resumed'))} /><Action icon="vote" label={t('rightpanel.callVote')} run={() => openSheet('vote', props)} /><Action icon="file" label={t('rightpanel.synthesize')} run={() => roomAct(props, 'synthesize', t('rightpanel.synthesisAsked'))} /><Action icon="sq" label={t('sheets.stopRoom')} run={() => roomAct(props, 'stop', t('rightpanel.stopped'))} /></Group>
    <Group><DesktopOnly title={t('sheets.splitView')} /><DesktopOnly title={t('sheets.moveToGroup')} /><Action icon="refresh" label={t('sheets.regenerateTitle')} run={() => { if (id) void regenerateTitleOf('room', id) }} /></Group>
    <Group><button type="button" className="opt" onClick={() => openSheet('clearroom', props)}><I n="erase" /><span className="tx"><b>{t('sheets.clearRoomAction')}</b></span></button><Action icon="trash" label={t('common.delete')} danger run={() => { if (id && window.confirm(t('sheets.deleteRoomConfirm'))) void mobileMutation({ mobileOp: 'room.delete', id }, t('sheets.roomDeleted')).then(() => go({ name: 'rooms' })) }} /></Group></>
}
function ArchiveMenu({ props }: { props: Props }) {
  const item = props.item as ArchiveItemWire | undefined
  const run = async (method: 'archive.restore' | 'archive.purge', ok: string) => {
    if (!item) return
    try {
      await client().rpc(method, { key: item.key })
      toast(ok)
    } catch (e) {
      // A refused purge says why (a Cowork session with unmerged work).
      toast(e instanceof Error ? e.message : t('common.didNotWork'))
    } finally {
      archiveChanged()
    }
  }
  return <><Title>{item?.title || t('sheets.archivedItem')}</Title>
    <Group><Action icon="refresh" label={t('sheets.restore')} run={() => void run('archive.restore', t('sheets.restored'))} />
    <Action icon="trash" label={t('sheets.deletePermanently')} danger run={() => { if (item && window.confirm(t('sheets.deleteItemConfirm', { title: item.title || t('sheets.thisItem') }))) void run('archive.purge', t('sheets.deletedPermanently')) }} /></Group></>
}
function ClearRoomSheet({ props }: { props: Props }) {
  const id = str(props.id)
  const [scope, setScope] = useState<'chat' | 'knowledge' | 'everything'>('chat')
  return <><Title>{t('sheets.clearRoom')}</Title>
    <Opt title={t('sheets.scope.chat')} sub={t('sheets.scope.chatSub')} selected={scope === 'chat'} onClick={() => setScope('chat')} />
    <Opt title={t('sheets.scope.knowledge')} sub={t('sheets.scope.knowledgeSub')} selected={scope === 'knowledge'} onClick={() => setScope('knowledge')} />
    <Opt title={t('sheets.scope.everything')} sub={t('sheets.scope.everythingSub')} selected={scope === 'everything'} onClick={() => setScope('everything')} />
    <button type="button" className="btn dan big" disabled={!id} onClick={() => { closeSheet(); if (id) void act('room.clear', { id, scope }, t('sheets.roomCleared')).then(() => invalidate(['rooms.get', 'thread.messages'])) }}>{t('sheets.clear')}</button></>
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
  const provider = settings.data?.webSearchProviders?.find((p) => p.id === settings.data?.webSearch.provider)?.name ?? settings.data?.webSearch.provider ?? t('sheets.web')
  const toggleWeb = () => {
    if (target === 'home') { app.set((s) => ({ composer: { ...s.composer, web: !s.composer.web } })); return }
    void act('settings.set', { key: 'webSearch', value: !web }, !web ? t('settings.web.on') : t('settings.web.off')).then(() => invalidate(['settings.get']))
  }
  const active = (tools.data?.servers ?? []).filter((x) => x.active).length
  const d = details.data
  const key = attachKey({ for: target === 'chat' || target === 'cowork' ? target : 'home', id })
  const pick = (files: FileList | null) => {
    closeSheet()
    if (files?.length) void addFiles(key, Array.from(files))
  }
  const computer = useApp((s) => s.computerName) ?? t('common.theComputer')
  const deskNote = cowork && id ? undefined : t('sheets.coworkOnly')
  return <><Title>{t('sheets.add')}</Title>
    <FilePick icon="image" label={t('sheets.photoLibrary')} accept="image/*" multiple onPick={pick} testId="add-photos" />
    <FilePick icon="camera" label={t('sheets.takePhoto')} accept="image/*" capture="environment" onPick={pick} testId="add-camera" />
    <FilePick icon="file" label={t('sheets.addFiles')} sub={t('sheets.upTo', { count: MAX_FILES })} multiple onPick={pick} testId="add-files" />
    <button type="button" className="opt" disabled={!!deskNote} aria-disabled={!!deskNote} onClick={() => openSheet('files', { id, pick: 'attach', key })} data-testid="add-desk"><I n="folder" /><span className="tx"><b>{t('sheets.filesOn', { computer })}</b><small>{deskNote ?? t('sheets.browseFolder')}</small></span></button>
    <button type="button" className="opt" disabled={!!deskNote} aria-disabled={!!deskNote} onClick={() => openSheet('files', { id, pick: 'ref', key })} data-testid="add-ref"><I n="at" /><span className="tx"><b>{t('sheets.referenceFile')}</b><small>{deskNote ?? t('sheets.referenceHint')}</small></span></button>
    <div className="ssec">{t('sheets.options')}</div>
    <Go lead={<FlintMark size={26} />} title={t('sheets.assistant')} sub={cowork ? 'Flint' : d ? (d.assistant.auto ? t('sheets.autoJev') : d.assistant.name) : t('sheets.autoJev')} sheet="assistant" props={props} />
    <Go icon="sliders" title={t('sheets.sampling')} sub={t('sheets.samplingSub')} sheet="params" />
    <Go icon="wrench" title={t('sheets.tools')} sub={tools.data ? t('sheets.enabled', { count: active }) : undefined} sheet="tools" />
    <button type="button" className={`row${web ? ' on' : ''}`} style={{ padding: '9px 10px' }} aria-pressed={web} onClick={toggleWeb} data-testid="plus-web"><I n="globe" /><span className="tx"><b>{t('sheets.webSearch')}</b><small>{provider}</small></span><Sw on={web} /></button>
    {target === 'chat' && d?.effort
      ? <Go icon="bulb" title={t('room.reasoning')} sub={t('sheets.effortUnder')} sheet="effort" props={{ id }} />
      : <Go icon="bulb" title={t('room.reasoning')} sheet="reason" props={{ for: target, id }} />}
    {cowork && <Go icon="slash" title={t('sheets.commandsSkills')} sheet="skills" />}</>
}

/** ComposerEffort's bar: Faster ↔ Smarter, Off only where the model can stop thinking. */
function EffortSheet({ props }: { props: Props }) {
  const id = str(props.id) ?? ''
  const { data } = useRpc('chat.details', { id }, Boolean(id))
  const e = data?.effort
  if (!e) return <><Title>{t('sheets.effort')}</Title><p className="sh">{t('sheets.effortOwn')}</p></>
  const { stops, shown } = effortStops(e)
  const i = Math.max(0, stops.indexOf(shown))
  const at = stops.length > 1 ? i / (stops.length - 1) : 0
  const choose = (choice: EffortChoiceWire | null, label: string) => void act('chat.effort', { id, choice }, label).then(() => invalidate(['chat.details']))
  return <><Grab />
    <div className="kv" style={{ background: 'none', border: 0, padding: 0 }}><h3>{t('sheets.effort')}</h3>{e.overridden && <button type="button" className="btn sm ghost" onClick={() => choose(null, t('sheets.effortReset'))}>{t('sheets.reset')}</button>}</div>
    <div className="kv" style={{ background: 'none', border: 0, padding: 0, fontSize: 12 }}><span>{t('sheets.faster')}</span><span>{t('sheets.smarter')}</span></div>
    <div className="etrack" role="radiogroup" aria-label={t('sheets.effort')}>
      {stops.map((x, j) => <button key={x} type="button" role="radio" aria-checked={j === i} className="estop" aria-label={stopLabel(x)} onClick={() => choose(x, t('sheets.effortChosen', { label: stopLabel(x) }))}><i /></button>)}
      <span className="ethumb" style={{ left: `calc(${at * 100}% - ${at * 28}px)` }} />
    </div>
    <div className="elabels">{stops.map((x) => <span key={x}>{stopLabel(x)}{x === e.recommended && <small>{t('ask.recommended')}</small>}</span>)}</div>
    <p className="sh">{e.canDisable ? `${t('sheets.canTurnOff', { name: data?.model?.name ?? t('sheets.thisModel') })} ` : ''}{t('sheets.appliesToChat')}</p></>
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
    ? () => { closeSheet(); app.set((s) => ({ compacting: { ...s.compacting, [id]: true } })); void act('chat.compact', { id }, t('cowork.compacting')) }
    : undefined
  if (target === 'cowork') {
    const u = cowork.data?.usage
    const c = cowork.data?.context
    return <><Title>{t('rightpanel.context')}</Title>{c?.windowTokens ? <Kv k={t('reply.context')} v={t('sheets.contextLine', { used: c.usedTokens.toLocaleString(), total: c.windowTokens.toLocaleString(), pct: Math.round((c.usedTokens / c.windowTokens) * 100) })} /> : null}{u ? <><Kv k={t('rightpanel.input')} v={t('reply.tokens', { count: u.inputTokens.toLocaleString() })} /><Kv k={t('rightpanel.output')} v={t('reply.tokens', { count: u.outputTokens.toLocaleString() })} /></> : <p className="sh">{t('reply.nothingSent')}</p>}<DesktopOnly title={t('reply.compact')} sub={t('sheets.coworkCompact')} /></>
  }
  if (target !== 'chat') return <><Title>{t('rightpanel.context')}</Title><ContextCard c={null} /></>
  return <><Title>{t('rightpanel.context')}</Title><ContextCard c={d?.context ?? null} speed={d?.speed} onCompact={compactNow} />
    {last && <><div className="ssec">{t('reply.last')}</div>
      {last.tokensPerSecond ? <Kv k={t('sheets.generation')} v={`${last.tokensPerSecond.toFixed(1)} t/s`} /> : null}
      {last.promptPerSecond ? <Kv k={t('sheets.reading')} v={`${last.promptPerSecond.toFixed(0)} t/s`} /> : null}
      {last.draft ? <Kv k={t('sheets.draftAccepted')} v={t('sheets.draftLine', { pct: Math.round((last.draft.accepted / last.draft.tokens) * 100), total: last.draft.tokens })} /> : null}
      {last.cache ? <Kv k={t('panels.promptCache')} v={last.cache === 'reused' ? t('panels.cacheReused') : t('panels.notReused')} /> : null}</>}
    {d && !d.canCompact && <DesktopOnly title={t('reply.compact')} sub={t('sheets.openToCompact')} />}</>
}

function ReplyStatsSheet({ props }: { props: Props }) {
  const m = props.meta as ReplyMeta | undefined
  return <><Title>{t('reply.last')}</Title>
    {m?.tokensPerSecond ? <Kv k={t('sheets.generation')} v={`${m.tokensPerSecond.toFixed(1)} t/s`} /> : null}
    {m?.promptPerSecond ? <Kv k={t('sheets.reading')} v={`${m.promptPerSecond.toFixed(0)} t/s`} /> : null}
    {m?.outputTokens ? <Kv k={t('rightpanel.tokens')} v={m.outputTokens.toLocaleString()} /> : null}
    {m?.cache ? <Kv k={t('panels.promptCache')} v={m.cache === 'reused' ? t('panels.cacheReused') : t('panels.notReused')} /> : null}
    {m?.draft ? <Kv k={t('sheets.draftAccepted')} v={t('sheets.draftLine', { pct: Math.round((m.draft.accepted / m.draft.tokens) * 100), total: m.draft.tokens })} /> : null}
    {m?.model ? <Kv k={t('chat.model')} v={<span className="mono">{m.model}</span>} /> : null}</>
}

function SkillsUsedSheet({ props }: { props: Props }) {
  const skills = Array.isArray(props.skills) ? (props.skills as string[]) : []
  return <><Title>{t('reply.skills', { count: skills.length })}</Title>
    {skills.map((name) => { const [plugin, skill] = name.includes(':') ? name.split(':', 2) : [null, name]; return <div key={name} className="opt"><span className="tx"><b>{plugin && <span className="muted">{plugin}:</span>}{skill}</b></span></div> })}</>
}

const ASSISTANT_SUB: Record<string, string> = { jan: t('sheets.asst.jan'), quartz: t('sheets.asst.quartz'), coal: t('sheets.asst.coal'), blaze: t('sheets.asst.blaze'), redstone: t('sheets.asst.redstone') }
/** The assistant picker (#47): Auto lets Jev route each turn, else Flint. */
function AssistantSheet({ props }: { props: Props }) {
  const target = str(props.for) ?? 'home'
  const id = str(props.id)
  const list = useRpc('assistants.list', {})
  const details = useRpc('chat.details', { id: id ?? '' }, target === 'chat' && Boolean(id))
  if (target !== 'chat' || !id) {
    return <><Title>{t('sheets.assistant')}</Title><Opt title="Flint" sub={target === 'cowork' ? t('sheets.thisCowork') : t('sheets.autoOnceStarts')} selected lead={<FlintMark size={26} />} onClick={closeSheet} /><DesktopOnly title={t('sheets.chooseAssistant')} sub={target === 'cowork' ? t('sheets.coworkAssistants') : t('sheets.pickAfterFirst')} /></>
  }
  const cur = details.data?.assistant
  const pick = (assistant: string, label: string) => { closeSheet(); void act('chat.assistant', { id, assistant }, label).then(() => invalidate(['chat.details'])) }
  const all = list.data?.assistants ?? []
  return <><Title>{t('sheets.assistant')}</Title>
    <Opt title={t('chat.auto')} sub={list.data?.routing === false ? t('sheets.routingOff') : t('sheets.routingOn')} selected={Boolean(cur?.auto)} lead={<span className="pico"><I n="wand" /></span>} onClick={() => pick('auto', t('sheets.assistantLabel', { name: t('chat.auto') }))} />
    {all.map((a) => { const icon = ASSISTANT_ICON[a.name]; return <Opt key={a.id} title={a.name} sub={a.description || ASSISTANT_SUB[a.id]} selected={!cur?.auto && cur?.id === a.id} lead={a.id === 'jan' ? <FlintMark size={26} /> : <span className="pico" style={icon ? { color: icon[1] } : undefined}><I n={icon?.[0] ?? 'sparkles'} /></span>} onClick={() => pick(a.id, t('sheets.assistantLabel', { name: a.name }))} /> })}
    <Go icon="sliders" title={t('sheets.parameters')} sheet="params" /></>
}

function MsgMenu({ props }: { props: Props }) {
  const id = str(props.id)
  const messageId = str(props.messageId)
  const text = str(props.text) ?? ''
  return <><Title>{t('chat.messageActions')}</Title>
    <Action icon="copy" label={t('common.copy')} run={() => void navigator.clipboard?.writeText(text).then(() => toast(t('common.copied')), () => toast(t('common.copyFailed')))} />
    <Action icon="fork" label={t('chat.forkFromHere')} run={() => { if (id) void forkFrom(id, messageId) }} />
    {id && messageId && <Action icon="refresh" label={t('sheets.regenerate')} run={() => void act('chat.regenerate', { id, messageId }, t('sheets.regenerating'))} />}
    {id && messageId && <Action icon="edit" label={t('sheets.edit')} run={() => { const next = window.prompt(t('sheets.editMessage'), text); if (next?.trim() && next.trim() !== text) void act('chat.edit', { id, messageId, text: next.trim() }, t('sheets.edited')) }} />}
    <DesktopOnly title={t('common.delete')} sub={t('sheets.deleteOnComputer')} /></>
}

function ModelGoneSheet({ props }: { props: Props }) {
  const id = str(props.id)
  return <><Title sub={t('chat.modelGoneBody', { name: str(props.name) ?? t('sheets.theModel') })}>{t('chat.modelGoneTitle')}</Title>
    <Opt title={t('rightpanel.thisChat')} sub={t('sheets.chooseToContinue')} selected onClick={() => openSheet('model', { for: 'chat', id })} />
    <button type="button" className="btn pri big" onClick={() => openSheet('model', { for: 'chat', id })}>{t('chat.chooseModel')}</button></>
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
  return <><Title sub={data?.root ?? undefined}>{pickMode === 'attach' ? t('sheets.attachFile') : pickMode === 'ref' ? t('sheets.referenceFileTitle') : t('panels.explorer')}</Title>
    {path && <Opt title=".." sub={path} lead={<I n="back" />} onClick={() => setPath(up)} />}
    {loading && !data && <p className="sh">{t('common.loading')}</p>}
    {error && <p className="sh">{error.message}</p>}
    {data && !data.root && <p className="sh">{t('sheets.noFolder')}</p>}
    {data?.entries.map((e) => <Opt key={e.relPath} title={e.name} lead={<I n={e.isDir ? 'folder' : 'file'} />} onClick={() => (e.isDir ? setPath(e.relPath) : open(e.relPath))} />)}
    {data?.truncated && <p className="sh">{t('sheets.truncated')}</p>}</>
}

const SHEETS: Record<string, (p: { props: Props }) => ReactNode> = {
  model: ModelSheet, reason: ReasonSheet, mode: ModeSheet, access: AccessSheet, stop: StopSheet, permdetails: PermDetailsSheet, vote: VoteSheet, runs: RunsSheet, conn: ConnSheet, palette: PaletteSheet, notifset: NotifSetSheet, tools: ToolsSheet, roomnew: RoomNewSheet, threadmenu: ThreadMenu, sessmenu: SessionMenu, roommenu: RoomMenu, clearroom: ClearRoomSheet, plus: PlusSheet, attach: PlusSheet, cwoptions: PlusSheet, effort: EffortSheet, tokens: TokensSheet, replystats: ReplyStatsSheet, skillsused: SkillsUsedSheet, assistant: AssistantSheet, msgmenu: MsgMenu, modelgone: ModelGoneSheet, files: FilesSheet,
  archivemenu: ArchiveMenu,
  studioset: () => <StudioSettingsSheet />, studioitem: ({ props }) => <StudioItemSheet item={props.item as StudioItemWire | undefined} />, voicesetup: () => <VoiceSetupSheet />,
  params: () => <><Title>{t('sheets.parameters')}</Title><DesktopOnly title={t('sheets.paramsTitle')} /></>,
  skills: () => <><Title>{t('sheets.commandsSkills')}</Title><DesktopOnly title={t('sheets.commandsSkills')} sub={t('sheets.skillsSub')} /></>,
  coworkmenu: () => <><Title>{t('home.modes.cowork')}</Title><Action icon="plus" label={t('nav.newSession')} run={() => go({ name: 'home', mode: 'cowork' })} /><DesktopOnly title={t('sheets.newGroup')} /><DesktopOnly title={t('sheets.importSession')} /></>,
  chatfilter: () => <><Title>{t('sheets.show')}</Title><Opt title={t('archive.filters.all')} selected onClick={closeSheet} /><DesktopOnly title={t('sheets.activeFilter')} /></>,
  workspace: ({ props }) => <><Title>{t('common.workspace')}</Title><Kv k={t('home.folder')} v={str(props.folder) ?? str(props.group) ?? t('rightpanel.none')} /><DesktopOnly title={t('sheets.changeFolder')} sub={t('sheets.changeFolderSub')} />{str(props.folder) && <Action icon="copy" label={t('sheets.copyPath')} run={() => void copyToClipboard(str(props.folder)!).then((ok) => toast(ok ? t('panels.pathCopied') : t('common.copyFailed')))} />}</>,
  temp: () => <><Title>{t('home.tempChat')}</Title><DesktopOnly title={t('home.tempChat')} sub={t('sheets.tempSub')} /></>,
  profile: () => <><Title>{t('sheets.workProfile')}</Title><DesktopOnly title={t('sheets.workProfile')} sub={t('sheets.profileSub')} /></>,
  worktree: ({ props }) => <><Title>{t('changes.sessionWorktree')}</Title><Kv k={t('sheets.branch')} v={str(props.branch) ?? t('changes.workingCopy')} /><Kv k={t('sheets.path')} v={str(props.path) ?? '—'} /><DesktopOnly title={t('sheets.applyMerge')} sub={t('sheets.applyMergeSub')} /></>,
}
export function SheetBody({ name, props }: { name: string; props: Props }) {
  const Cmp = SHEETS[name]
  return Cmp ? <Cmp props={props} /> : null
}
