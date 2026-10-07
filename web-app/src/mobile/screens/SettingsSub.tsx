// Phone settings. Only settings with an established safe remote setter are
// interactive; desktop-only/security-sensitive rows are visibly read-only.
import type { ReactNode } from 'react'
import type { NotificationPrefs, SettingsSnapshot } from '@/lib/remote/protocol'
import { DEFAULT_NOTIFY } from '../state/controls'
import { I } from '../ui/icons'
import { Empty, FlintMark, TypeSafeMark } from '../ui/bits'
import { Grp, IRow } from '../ui/ios'
import { act, app, back, client, go, openSheet, setTheme, toast, useApp } from '../state/app'
import { invalidate, useRpc } from '../state/rpc'
import { reachLabel } from '../state/sessions'
import PushSettings from './PushSettings'
import { t } from '../i18n'

const readOnly = (label: ReactNode, val?: ReactNode, sub = t('settings.changeOnComputer')) => <IRow label={label} val={val} sub={sub} />

function NotifyRows() {
  const { data } = useRpc('settings.get', {})
  const prefs = data?.notifications ?? DEFAULT_NOTIFY
  const flip = (k: keyof NotificationPrefs) => () =>
    void act('settings.set', { key: 'notifications', value: { ...prefs, [k]: !prefs[k] } }).then(() => invalidate(['settings.get']))
  return <Grp cap={t('settings.notify.cap')} foot={t('settings.notify.foot')}>
    <IRow label={t('push.types.approvals')} sw={prefs.approvals} onClick={flip('approvals')} />
    <IRow label={t('push.types.runFinished')} sw={prefs.runFinished} onClick={flip('runFinished')} />
    <IRow label={t('push.types.runFailed')} sw={prefs.errors} onClick={flip('errors')} />
    <IRow label={t('push.types.roomWaiting')} sw={prefs.roomTurns} onClick={flip('roomTurns')} />
  </Grp>
}

function OnComputer({ what, children }: { what: string; children?: ReactNode }) {
  return <><Grp><Empty icon={<I n="monitor" size={18} />}>{t('settings.managed', { what })}</Empty></Grp>{children}</>
}

type Page = [title: string, body: (s: SettingsSnapshot | undefined) => ReactNode]

function RemotePage({ s }: { s: SettingsSnapshot | undefined }) {
  const me = useApp((st) => st.me)
  const unpair = async () => {
    try { await client().unpair() } catch { /* local forget still proceeds */ }
    app.set({ auth: 'unpaired' })
    toast(t('settings.unpaired'))
  }
  return <>
    <Grp cap={t('settings.rows.remote')} foot={t('settings.remote.foot')}>
      {readOnly(t('settings.rows.remote'), t('common.on'), t('settings.managedOnComputer'))}
      {readOnly(t('settings.remote.allowApprovals'), s?.remote?.allowApprovals ? t('common.on') : t('common.off'), t('settings.managedOnComputer'))}
      {readOnly(t('settings.remote.allowAlways'), s?.remote?.allowAlwaysAllow ? t('common.on') : t('common.off'), t('settings.managedOnComputer'))}
    </Grp>
    <Grp cap={t('settings.groups.phone')} foot={t('settings.remote.nameFoot')}>
      {readOnly(t('settings.name'), me?.name ?? '—', t('settings.readOnlyPhone'))}
      <IRow label={t('settings.remote.paired')} val={me ? new Date(me.pairedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—'} />
      <IRow label={t('settings.remote.reachable')} val={reachLabel()} />
    </Grp>
    <Grp foot={t('settings.remote.unpairFoot')}>
      <IRow label={<span style={{ color: 'var(--destructive)' }}>{t('settings.remote.unpair')}</span>} onClick={() => void unpair()} testId="unpair" />
    </Grp>
  </>
}

function HardwarePage() {
  const { data } = useRpc('system.info', {})
  if (!data) return <Empty>{t('settings.loading')}</Empty>
  const gb = (mb: number) => `${Math.round(mb / 1024)} GB`
  return <>
    <Grp cap={t('settings.hw.os')}><IRow label={t('settings.name')} val={data.os || '—'} /></Grp>
    <Grp cap={t('settings.hw.cpu')}><IRow label={t('settings.hw.model')} val={data.cpu.name || '—'} /><IRow label={t('settings.hw.arch')} val={data.cpu.arch || '—'} /><IRow label={t('settings.hw.cores')} val={String(data.cpu.cores || '—')} /></Grp>
    {data.gpus.length > 0 && <Grp cap={t('settings.hw.gpu')}>{data.gpus.map((g) => <IRow key={g.name} label={g.name} val={`${gb(g.vram)}${g.driver ? ` · ${g.driver}` : ''}`} />)}</Grp>}
    <Grp cap={t('settings.hw.memory')}><IRow label={t('settings.hw.ram')} val={data.ram.total ? gb(data.ram.total) : '—'} /></Grp>
  </>
}

function ComputerPage() {
  const computer = useApp((st) => st.computerName) ?? t('common.yourComputerCap')
  const status = useRpc('status', {})
  const sys = useRpc('system.info', {})
  const conn = useApp((st) => st.conn)
  return <>
    <Grp cap={t('settings.computer.status')}><IRow label={t('settings.computer.connection')} val={`${reachLabel()} · ${conn === 'connected' ? t('settings.computer.connected') : conn}`} /><IRow label={t('settings.computer.address')} val={location.host} /><IRow label={t('settings.computer.modelsLoaded')} val={String(status.data?.modelsLoaded ?? '—')} /><IRow label={t('settings.computer.localApi')} val={sys.data ? (sys.data.localApi.running ? t('common.on') : t('common.off')) : '—'} /></Grp>
    <Grp><IRow icon="x-monitor" label={t('settings.computer.systemMonitor')} onClick={() => go({ name: 'system' })} /><IRow icon="x-refresh" label={t('settings.computer.details')} onClick={() => openSheet('conn')} /></Grp>
    <p className="muted" style={{ fontSize: 12, padding: '0 16px', margin: 0 }}>{computer}</p>
  </>
}

function AppearancePage() {
  const theme = useApp((st) => st.theme)
  return <Grp cap={t('settings.appearance.theme')} foot={t('settings.appearance.foot')}>
    <IRow label={t('theme.system')} val={theme === 'system' ? '✓' : undefined} onClick={() => setTheme('system')} />
    <IRow label={t('theme.dark')} val={theme === 'dark' ? '✓' : undefined} onClick={() => setTheme('dark')} />
    <IRow label={t('theme.light')} val={theme === 'light' ? '✓' : undefined} onClick={() => setTheme('light')} />
  </Grp>
}

function ReasoningPage() {
  const reason = useApp((st) => st.composer.reason)
  return <>
    <Grp cap={t('settings.reasoning.newChats')}><IRow label={t('settings.reasoning.label')} val={reason === 'auto' ? t('chat.auto') : reason === 'on' ? t('common.on') : t('common.off')} onClick={() => openSheet('reason', { for: 'home' })} /></Grp>
    <Grp foot={t('settings.reasoning.foot')}>{readOnly(t('settings.reasoning.budget'), t('settings.reasoning.desktopSetting'), t('settings.readOnlyPhone'))}</Grp>
  </>
}

const PAGES: Record<string, Page> = {
  general: [t('settings.rows.general'), (s) => <><Grp cap={t('settings.general.cap')}>{readOnly(t('settings.general.appData'), t('settings.onComputer'))}{readOnly(t('settings.general.spell'), s?.spellCheck ? t('common.on') : t('common.off'))}{readOnly(t('settings.general.language'), s?.language ?? '—')}{readOnly(t('settings.general.reset'), undefined, t('settings.computerOnly'))}</Grp></>],
  assistants: [t('settings.rows.assistants'), () => <OnComputer what={t('settings.what.assistants')} />],
  attachments: [t('settings.rows.attachments'), () => <OnComputer what={t('settings.what.attachments')} />],
  memory: [t('settings.rows.memory'), () => <OnComputer what={t('settings.what.memory')} />],
  perms: [t('settings.rows.permissions'), () => <OnComputer what={t('settings.what.perms')} />],
  shortcuts: [t('settings.rows.shortcuts'), () => <Grp foot={t('settings.shortcuts.foot')}><IRow label={t('settings.shortcuts.palette')} val="Ctrl K" /><IRow label={t('settings.shortcuts.newChat')} val="Ctrl N" /><IRow label={t('settings.shortcuts.sidebar')} val="Ctrl B" /><IRow label={t('settings.shortcuts.stop')} val="Esc" /></Grp>],
  websearch: [t('settings.rows.webSearch'), (s) => <><Grp foot={t('settings.web.foot')}><IRow label={t('settings.web.enable')} sw={s?.webSearch.enabled ?? false} onClick={() => void act('settings.set', { key: 'webSearch', value: !s?.webSearch.enabled }, !s?.webSearch.enabled ? t('settings.web.on') : t('settings.web.off')).then(() => invalidate(['settings.get']))} /></Grp><Grp cap={t('settings.web.provider')} foot={t('settings.web.providerFoot')}>{s?.webSearchProviders ? s.webSearchProviders.map((p) => <IRow key={p.id} label={p.name} val={p.id === s.webSearch.provider ? '✓' : undefined} sub={p.id === 'duckduckgo' ? t('settings.web.ddg') : !p.needsKey ? t('settings.web.noKey') : p.configured ? t('settings.web.keySet') : t('settings.web.needsKey')} testId={`ws-${p.id}`} />) : readOnly(t('settings.web.providerRow'), s?.webSearch.provider ?? t('settings.web.default'))}</Grp></>],
  claudecode: [t('settings.rows.claudeCode'), () => <OnComputer what={t('settings.what.claudeCode')} />],
  jev: [t('settings.rows.jev'), (s) => <><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '4px 0 2px' }}><TypeSafeMark size={52} /><b style={{ fontSize: 17 }}>{t('settings.jev.title')}</b><span className="muted" style={{ fontSize: 12.5 }}>{t('settings.jev.by')}</span></div><Grp cap={t('settings.jev.connection')}>{readOnly(t('settings.jev.apiKey'), t('settings.onComputer'))}</Grp><Grp cap={t('settings.jev.features')}>{readOnly(t('settings.jev.skills'), s?.jev?.skills ?? '—')}{readOnly(t('settings.jev.rerank'), s?.jev?.rerank ?? '—')}</Grp><Grp cap={t('settings.jev.automatic')} foot={t('settings.jev.changedOnComputer')}>{[['route', t('settings.jev.route'), s?.automation?.routeAssistants], ['apply', t('settings.jev.apply'), s?.automation?.activateSkills]].map(([id, label, on]) => <IRow key={String(id)} label={label as string} sw={Boolean(on)} sub={t('settings.changeOnComputer')} testId={`auto-${String(id)}`} />)}</Grp></>],
  extensions: [t('settings.rows.extensions'), () => <OnComputer what={t('settings.what.extensions')} />],
  localapi: [t('settings.rows.localApi'), (s) => <><Grp cap={t('settings.computer.status')}>{readOnly(t('settings.rows.localApi'), s?.localApi.enabled ? t('common.on') : t('common.off'), t('settings.managedOnComputer'))}</Grp><Grp cap={t('settings.api.server')}><IRow label={t('settings.api.host')} val={s?.localApi.host ?? '—'} /><IRow label={t('settings.api.port')} val={s ? String(s.localApi.port) : '—'} /><IRow label={t('settings.api.prefix')} val={s?.localApi.prefix ?? '—'} /><IRow label="CORS" val={s?.localApi.cors ? t('common.on') : t('common.off')} /><IRow label={t('settings.api.key')} val={s ? (s.localApi.hasKey ? t('settings.api.set') : t('settings.api.notSet')) : '—'} /></Grp></>],
  proxy: [t('settings.rows.proxy'), (s) => <Grp cap={t('settings.proxy.cap')} foot={t('settings.proxy.foot')}>{readOnly(t('settings.proxy.enabled'), s?.proxy.enabled ? t('common.on') : t('common.off'))}{readOnly(t('settings.proxy.url'), s?.proxy.url || t('settings.api.notSet'))}{readOnly(t('settings.proxy.verify'), s?.proxy.verifySsl ? t('common.on') : t('common.off'))}<IRow label={t('settings.proxy.noProxy')} val={s?.proxy.noProxy || '—'} /></Grp>],
  hardware: [t('settings.rows.hardware'), () => <HardwarePage />],
  agenttools: [t('settings.rows.agentTools'), (s) => <Grp foot={t('settings.agentTools.foot')}>{readOnly(t('settings.agentTools.enable'), s?.agentTools ? t('common.on') : t('common.off'), t('settings.computerOnly'))}</Grp>],
  help: [t('settings.rows.help'), () => <OnComputer what={t('settings.what.help')} />],
  about: [t('settings.rows.about'), (s) => <><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 0' }}><FlintMark size={72} /><b style={{ fontSize: 20 }}>Flint</b><span className="muted">{t('settings.about.version', { version: s?.version ?? VERSION })}</span></div><Grp><IRow label={t('settings.about.phoneApp')} val={VERSION} /><IRow label={t('settings.about.fork')} val="janhq/jan" /></Grp></>],
  computer: [t('settings.computer.title'), () => <ComputerPage />],
  remote: [t('settings.rows.remote'), (s) => <RemotePage s={s} />],
  notifs: [t('settings.rows.notifications'), () => <><PushSettings /><NotifyRows /></>],
  appearance: [t('settings.rows.appearance'), () => <AppearancePage />],
  sound: [t('settings.rows.sound'), () => <OnComputer what={t('settings.what.sound')} />],
  reasoning: [t('settings.rows.reasoning'), () => <ReasoningPage />],
}

export default function SettingsSub({ sub }: { sub: string }) {
  const { data } = useRpc('settings.get', {})
  const page = PAGES[sub]
  return <><div className="top"><button type="button" className="navback" onClick={() => back({ name: 'settings' })}><I n="chevl" />{t('settings.title')}</button><div className="crumb" style={{ textAlign: 'center', marginRight: 70 }}><b>{page?.[0] ?? t('settings.title')}</b></div></div><div className="scroll" style={{ padding: 0 }}><div className="ios" style={{ paddingTop: 8 }}>{page ? page[1](data) : <Empty>{t('settings.nothingHere')}</Empty>}</div></div></>
}
