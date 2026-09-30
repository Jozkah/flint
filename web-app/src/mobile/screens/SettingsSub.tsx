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

const readOnly = (label: ReactNode, val?: ReactNode, sub = 'Change on the computer') => <IRow label={label} val={val} sub={sub} />

function NotifyRows() {
  const { data } = useRpc('settings.get', {})
  const prefs = data?.notifications ?? DEFAULT_NOTIFY
  const flip = (k: keyof NotificationPrefs) => () =>
    void act('settings.set', { key: 'notifications', value: { ...prefs, [k]: !prefs[k] } }).then(() => invalidate(['settings.get']))
  return <Grp cap="Notify me when">
    <IRow label="An approval is waiting" sw={prefs.approvals} onClick={flip('approvals')} />
    <IRow label="A run finishes" sw={prefs.runFinished} onClick={flip('runFinished')} />
    <IRow label="A run fails or stops" sw={prefs.errors} onClick={flip('errors')} />
    <IRow label="A Room is waiting for you" sw={prefs.roomTurns} onClick={flip('roomTurns')} />
  </Grp>
}

function OnComputer({ what, children }: { what: string; children?: ReactNode }) {
  return <><Grp><Empty icon={<I n="monitor" size={18} />}>{what} are managed on the computer.</Empty></Grp>{children}</>
}

type Page = [title: string, body: (s: SettingsSnapshot | undefined) => ReactNode]

function RemotePage({ s }: { s: SettingsSnapshot | undefined }) {
  const me = useApp((st) => st.me)
  const unpair = async () => {
    try { await client().unpair() } catch { /* local forget still proceeds */ }
    app.set({ auth: 'unpaired' })
    toast('This phone is no longer paired')
  }
  return <>
    <Grp cap="Remote access" foot="Listening, network interface and phone approval policy are security settings and stay on the computer.">
      {readOnly('Remote access', 'On', 'Managed on the computer')}
      {readOnly('Allow approvals from phones', s?.remote?.allowApprovals ? 'On' : 'Off', 'Managed on the computer')}
      {readOnly('Allow “Always allow” from phones', s?.remote?.allowAlwaysAllow ? 'On' : 'Off', 'Managed on the computer')}
    </Grp>
    <Grp cap="This phone" foot="The paired-device name is owned by the computer’s pairing record; renaming it is not exposed remotely.">
      {readOnly('Name', me?.name ?? '—', 'Read-only on this phone')}
      <IRow label="Paired" val={me ? new Date(me.pairedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—'} />
      <IRow label="Reachable through" val={reachLabel()} />
    </Grp>
    <Grp foot="The computer forgets this phone. Pair again with a new QR code.">
      <IRow label={<span style={{ color: 'var(--destructive)' }}>Unpair this phone</span>} onClick={() => void unpair()} testId="unpair" />
    </Grp>
  </>
}

function HardwarePage() {
  const { data } = useRpc('system.info', {})
  if (!data) return <Empty>Loading…</Empty>
  const gb = (mb: number) => `${Math.round(mb / 1024)} GB`
  return <>
    <Grp cap="Operating System"><IRow label="Name" val={data.os || '—'} /></Grp>
    <Grp cap="CPU"><IRow label="Model" val={data.cpu.name || '—'} /><IRow label="Architecture" val={data.cpu.arch || '—'} /><IRow label="Cores" val={String(data.cpu.cores || '—')} /></Grp>
    {data.gpus.length > 0 && <Grp cap="GPU">{data.gpus.map((g) => <IRow key={g.name} label={g.name} val={`${gb(g.vram)}${g.driver ? ` · ${g.driver}` : ''}`} />)}</Grp>}
    <Grp cap="Memory"><IRow label="RAM" val={data.ram.total ? gb(data.ram.total) : '—'} /></Grp>
  </>
}

function ComputerPage() {
  const computer = useApp((st) => st.computerName) ?? 'Your computer'
  const status = useRpc('status', {})
  const sys = useRpc('system.info', {})
  const conn = useApp((st) => st.conn)
  return <>
    <Grp cap="Status"><IRow label="Connection" val={`${reachLabel()} · ${conn === 'connected' ? 'connected' : conn}`} /><IRow label="Address" val={location.host} /><IRow label="Models loaded" val={String(status.data?.modelsLoaded ?? '—')} /><IRow label="Local API" val={sys.data ? (sys.data.localApi.running ? 'On' : 'Off') : '—'} /></Grp>
    <Grp><IRow icon="x-monitor" label="System Monitor" onClick={() => go({ name: 'system' })} /><IRow icon="x-refresh" label="Connection details" onClick={() => openSheet('conn')} /></Grp>
    <p className="muted" style={{ fontSize: 12, padding: '0 16px', margin: 0 }}>{computer}</p>
  </>
}

function AppearancePage() {
  const theme = useApp((st) => st.theme)
  return <Grp cap="Theme" foot="Applies to this phone. The accent colour follows the computer.">
    <IRow label="Match phone" val={theme === 'system' ? '✓' : undefined} onClick={() => setTheme('system')} />
    <IRow label="Dark" val={theme === 'dark' ? '✓' : undefined} onClick={() => setTheme('dark')} />
    <IRow label="Light" val={theme === 'light' ? '✓' : undefined} onClick={() => setTheme('light')} />
  </Grp>
}

function ReasoningPage() {
  const reason = useApp((st) => st.composer.reason)
  return <>
    <Grp cap="New chats from this phone"><IRow label="Reasoning" val={reason === 'auto' ? 'Auto' : reason === 'on' ? 'On' : 'Off'} onClick={() => openSheet('reason', { for: 'home' })} /></Grp>
    <Grp foot="Per-model thinking budgets and provider-specific reasoning effort are persisted by the desktop model settings and are not duplicated as phone-only state.">{readOnly('Thinking budget / effort', 'Desktop model setting', 'Read-only on this phone')}</Grp>
  </>
}

const PAGES: Record<string, Page> = {
  general: ['General', (s) => <><Grp cap="Computer settings">{readOnly('App Data', 'On the computer')}{readOnly('Spell Check', s?.spellCheck ? 'On' : 'Off')}{readOnly('Language', s?.language ?? '—')}{readOnly('Reset To Factory Settings', undefined, 'Computer only')}</Grp></>],
  assistants: ['Assistants', () => <OnComputer what="Assistants" />],
  attachments: ['Attachments', () => <OnComputer what="Attachment settings" />],
  memory: ['Memory', () => <OnComputer what="Memories" />],
  perms: ['Permissions', () => <OnComputer what="Standing grants and default modes" />],
  shortcuts: ['Shortcuts', () => <Grp foot="Keyboard shortcuts on the computer."><IRow label="Command Palette" val="Ctrl K" /><IRow label="New Chat" val="Ctrl N" /><IRow label="Toggle sidebar" val="Ctrl B" /><IRow label="Stop generating" val="Esc" /></Grp>],
  websearch: ['Web Search', (s) => <><Grp foot="Advertise web tools to models that support tool use."><IRow label="Enable Web Search" sw={s?.webSearch.enabled ?? false} onClick={() => void act('settings.set', { key: 'webSearch', value: !s?.webSearch.enabled }, !s?.webSearch.enabled ? 'Web search on' : 'Web search off').then(() => invalidate(['settings.get']))} /></Grp><Grp cap="Search Provider">{readOnly('Provider', s?.webSearch.provider ?? 'Default')}</Grp></>],
  claudecode: ['Claude Code', () => <OnComputer what="Claude Code models and configuration" />],
  jev: ['Jev', (s) => <><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '4px 0 2px' }}><TypeSafeMark size={52} /><b style={{ fontSize: 17 }}>Jev decision support</b><span className="muted" style={{ fontSize: 12.5 }}>by TypeSafe</span></div><Grp cap="Connection">{readOnly('TypeSafe API key', 'On the computer')}</Grp><Grp cap="Features">{readOnly('Skill suggestions', s?.jev?.skills ?? '—')}{readOnly('Rerank retrieved sources', s?.jev?.rerank ?? '—')}</Grp></>],
  extensions: ['Extensions', () => <OnComputer what="Plugins and extensions" />],
  localapi: ['Local API Server', (s) => <><Grp cap="Status">{readOnly('Local API Server', s?.localApi.enabled ? 'On' : 'Off', 'Managed on the computer')}</Grp><Grp cap="Server"><IRow label="Host" val={s?.localApi.host ?? '—'} /><IRow label="Port" val={s ? String(s.localApi.port) : '—'} /><IRow label="API prefix" val={s?.localApi.prefix ?? '—'} /><IRow label="CORS" val={s?.localApi.cors ? 'On' : 'Off'} /><IRow label="API key" val={s ? (s.localApi.hasKey ? 'Set' : 'Not set') : '—'} /></Grp></>],
  proxy: ['HTTPS Proxy', (s) => <Grp cap="Proxy" foot="Proxy changes stay on the computer because they affect all providers and network traffic.">{readOnly('Enabled', s?.proxy.enabled ? 'On' : 'Off')}{readOnly('Proxy URL', s?.proxy.url || 'Not set')}{readOnly('Verify SSL certificates', s?.proxy.verifySsl ? 'On' : 'Off')}<IRow label="No proxy for" val={s?.proxy.noProxy || '—'} /></Grp>],
  hardware: ['Hardware', () => <HardwarePage />],
  agenttools: ['Agent Tools', (s) => <Grp foot="Agent Tools grants workspace capabilities and is managed on the computer.">{readOnly('Enable Agent Tools', s?.agentTools ? 'On' : 'Off', 'Computer only')}</Grp>],
  help: ['Help & feedback', () => <OnComputer what="Problem reports and release notes" />],
  about: ['About Flint', (s) => <><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 0' }}><FlintMark size={72} /><b style={{ fontSize: 20 }}>Flint</b><span className="muted">Version {s?.version ?? VERSION}</span></div><Grp><IRow label="Phone app" val={VERSION} /><IRow label="Fork of Jan" val="janhq/jan" /></Grp></>],
  computer: ['Computer', () => <ComputerPage />],
  remote: ['Remote access', (s) => <RemotePage s={s} />],
  notifs: ['Notifications', () => <><NotifyRows /><Grp foot="Push notifications while the PWA is closed are not enabled yet.">{readOnly('Background push', 'Not available', 'No inactive control')}</Grp></>],
  appearance: ['Appearance', () => <AppearancePage />],
  sound: ['Sound & haptics', () => <OnComputer what="Sounds and haptics" />],
  reasoning: ['Reasoning & thinking', () => <ReasoningPage />],
}

export default function SettingsSub({ sub }: { sub: string }) {
  const { data } = useRpc('settings.get', {})
  const page = PAGES[sub]
  return <><div className="top"><button type="button" className="navback" onClick={() => back({ name: 'settings' })}><I n="chevl" />Settings</button><div className="crumb" style={{ textAlign: 'center', marginRight: 70 }}><b>{page?.[0] ?? 'Settings'}</b></div></div><div className="scroll" style={{ padding: 0 }}><div className="ios" style={{ paddingTop: 8 }}>{page ? page[1](data) : <Empty>Nothing here.</Empty>}</div></div></>
}
