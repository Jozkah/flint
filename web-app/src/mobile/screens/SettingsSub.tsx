// Settings sub-pages. Values are read from the computer (`settings.get`,
// `system.info`, `/me`); changing one asks the computer (`settings.set`),
// which says so when it cannot yet. Phone-only choices (theme) apply here.
import type { ReactNode } from 'react'
import type { SettingsSnapshot } from '@/lib/remote/protocol'
import { I } from '../ui/icons'
import { Empty, FlintMark, TypeSafeMark } from '../ui/bits'
import { Grp, IRow } from '../ui/ios'
import { LEVELS } from '../shell/labels'
import { act, app, back, client, go, notYet, openSheet, setTheme, toast, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { reachLabel } from '../state/sessions'

const set = (key: string, value: unknown) => () => void act('settings.set', { key, value })
const later = (what: string) => () => notYet(what)
const cap = (v?: string) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : '—')

function Lvl({ value, onPick }: { value: string; onPick: (l: string) => void }) {
  return (
    <div className="lvl">
      {LEVELS.map(([l, hint]) => (
        <button key={l} type="button" aria-pressed={l === value} onClick={() => onPick(l)}>
          {l}
          <small>{hint}</small>
        </button>
      ))}
    </div>
  )
}

function OnComputer({ what }: { what: string }) {
  return (
    <Grp>
      <Empty icon={<I n="monitor" size={18} />}>{what} are managed on the computer for now.</Empty>
    </Grp>
  )
}

type Page = [title: string, body: (s: SettingsSnapshot | undefined) => ReactNode]

function RemotePage({ s }: { s: SettingsSnapshot | undefined }) {
  const me = useApp((st) => st.me)
  const unpair = async () => {
    try {
      await client().unpair()
    } catch {
      // Forgotten here either way.
    }
    app.set({ auth: 'unpaired' })
    toast('This phone is no longer paired')
  }
  return (
    <>
      <Grp foot="Paired phones can use Flint on the computer while it runs.">
        <IRow label="Remote access" sw onClick={later('Turning remote access off')} />
      </Grp>
      <Grp cap="This phone">
        <IRow label="Name" val={me?.name ?? '—'} onClick={later('Renaming this phone')} />
        <IRow label="Paired" val={me ? new Date(me.pairedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—'} />
        <IRow label="Reachable through" val={reachLabel()} />
      </Grp>
      <Grp
        cap="Approvals"
        foot={
          s?.remote
            ? s.remote.allowApprovals
              ? s.remote.allowAlwaysAllow
                ? 'You can approve any action from here, including standing grants.'
                : 'You can allow or deny actions from here, but not grant "Always allow".'
              : 'Approvals from phones are turned off on the computer.'
            : 'Set on the computer, in Settings › Remote access.'
        }
      >
        <IRow label="Allow approvals from this phone" sw={s?.remote?.allowApprovals ?? false} onClick={set('remote.allowApprovals', !s?.remote?.allowApprovals)} />
        <IRow label='Allow "Always allow" from this phone' sw={s?.remote?.allowAlwaysAllow ?? false} onClick={set('remote.allowAlwaysAllow', !s?.remote?.allowAlwaysAllow)} />
      </Grp>
      <Grp foot="The computer forgets this phone. Pair again with a new QR code.">
        <IRow label={<span style={{ color: 'var(--destructive)' }}>Unpair this phone</span>} onClick={() => void unpair()} testId="unpair" />
      </Grp>
    </>
  )
}

function HardwarePage() {
  const { data } = useRpc('system.info', {})
  if (!data) return <Empty>Loading…</Empty>
  const gb = (mb: number) => `${Math.round(mb / 1024)} GB`
  return (
    <>
      <Grp cap="Operating System">
        <IRow label="Name" val={data.os || '—'} />
      </Grp>
      <Grp cap="CPU">
        <IRow label="Model" val={data.cpu.name || '—'} />
        <IRow label="Architecture" val={data.cpu.arch || '—'} />
        <IRow label="Cores" val={String(data.cpu.cores || '—')} />
        {data.cpu.extensions.length > 0 && (
          <IRow label="Instructions" val={data.cpu.extensions.filter((e) => /avx|neon|sve/i.test(e)).slice(0, 3).join(', ') || data.cpu.extensions.slice(0, 3).join(', ')} />
        )}
      </Grp>
      {data.gpus.length > 0 && (
        <Grp cap="GPU">
          {data.gpus.map((g) => (
            <IRow key={g.name} label={g.name} val={`${gb(g.vram)}${g.driver ? ` · ${g.driver}` : ''}`} />
          ))}
        </Grp>
      )}
      <Grp cap="Memory">
        <IRow label="RAM" val={data.ram.total ? gb(data.ram.total) : '—'} />
      </Grp>
    </>
  )
}

function ComputerPage() {
  const computer = useApp((st) => st.computerName) ?? 'Your computer'
  const status = useRpc('status', {})
  const sys = useRpc('system.info', {})
  const conn = useApp((st) => st.conn)
  return (
    <>
      <Grp cap="Status">
        <IRow label="Connection" val={`${reachLabel()} · ${conn === 'connected' ? 'connected' : conn}`} />
        <IRow label="Address" val={location.host} />
        <IRow label="Models loaded" val={String(status.data?.modelsLoaded ?? '—')} />
        <IRow label="Local API" val={sys.data ? (sys.data.localApi.running ? 'On' : 'Off') : '—'} />
      </Grp>
      <Grp>
        <IRow icon="x-monitor" label="System Monitor" onClick={() => go({ name: 'system' })} />
        <IRow icon="x-refresh" label="Switch computer" onClick={() => openSheet('conn')} />
        <IRow icon="x-plus" label="Pair another computer" onClick={() => toast('Scan the QR code in Settings › Remote access on the other computer')} />
      </Grp>
      <p className="muted" style={{ fontSize: 12, padding: '0 16px', margin: 0 }}>
        {computer}
      </p>
    </>
  )
}

function AppearancePage() {
  const theme = useApp((st) => st.theme)
  return (
    <>
      <Grp cap="Theme" foot="Applies to this phone. The accent colour follows the computer.">
        <IRow label="Match phone" val={theme === 'system' ? '✓' : undefined} onClick={() => setTheme('system')} />
        <IRow label="Dark" val={theme === 'dark' ? '✓' : undefined} onClick={() => setTheme('dark')} />
        <IRow label="Light" val={theme === 'light' ? '✓' : undefined} onClick={() => setTheme('light')} />
      </Grp>
    </>
  )
}

function ReasoningPage() {
  const budget = useApp((st) => st.composer.budget)
  const reason = useApp((st) => st.composer.reason)
  const pick = (l: string) => app.set((st) => ({ composer: { ...st.composer, budget: l } }))
  return (
    <>
      <Grp cap="New chats from this phone">
        <IRow label="Reasoning" val={reason === 'auto' ? 'Auto' : reason === 'on' ? 'On' : 'Off'} onClick={() => openSheet('reason', { for: 'home' })} />
      </Grp>
      <div className="igrp">
        <div className="cap">Thinking budget · llama.cpp</div>
        <div className="ilist">
          <Lvl value={budget} onPick={pick} />
        </div>
        <div className="foot2">A share of the model's live context window. Chat, Cowork and Rooms defaults are set on the computer.</div>
      </div>
    </>
  )
}

const PAGES: Record<string, Page> = {
  general: [
    'General',
    (s) => (
      <>
        <Grp cap="Data folder" foot="Location for messages, downloaded models and other data.">
          <IRow label="App Data" sub="On the computer" onClick={later('Changing the data folder')} />
          <IRow label="App Logs" sub="View detailed logs of the App." onClick={() => go({ name: 'system' })} />
        </Grp>
        <Grp>
          <IRow label="Spell Check" sw={s?.spellCheck ?? false} onClick={set('general.spellCheck', !s?.spellCheck)} />
          <IRow label="Language" val={s?.language ?? '—'} onClick={later('Changing the language')} />
        </Grp>
        <Grp foot="Restores Flint to its initial state, erasing all models and chat history. Only from the computer.">
          <IRow label="Reset To Factory Settings" onClick={later('Resetting Flint')} />
        </Grp>
      </>
    ),
  ],
  assistants: ['Assistants', () => <OnComputer what="Assistants" />],
  attachments: ['Attachments', () => <OnComputer what="Attachment settings" />],
  memory: ['Memory', () => <OnComputer what="Memories" />],
  perms: ['Permissions', () => <OnComputer what="Standing grants and default modes" />],
  shortcuts: [
    'Shortcuts',
    () => (
      <Grp foot="Keyboard shortcuts on the computer.">
        <IRow label="Command Palette" val="Ctrl K" />
        <IRow label="New Chat" val="Ctrl N" />
        <IRow label="Toggle sidebar" val="Ctrl B" />
        <IRow label="Stop generating" val="Esc" />
      </Grp>
    ),
  ],
  websearch: [
    'Web Search',
    (s) => (
      <>
        <Grp foot="Advertise the web_search and web_fetch tools to models that support tool use.">
          <IRow label="Enable Web Search" sw={s?.webSearch.enabled ?? false} onClick={set('webSearch.enabled', !s?.webSearch.enabled)} />
        </Grp>
        <Grp cap="Search Provider" foot="Choose the backend that answers web_search and web_fetch.">
          <IRow label="Provider" val={s?.webSearch.provider ?? 'Default'} onClick={later('Changing the search provider')} />
        </Grp>
      </>
    ),
  ],
  claudecode: ['Claude Code', () => <OnComputer what="Claude Code models and configuration" />],
  jev: [
    'Jev',
    (s) => (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '4px 0 2px' }}>
          <TypeSafeMark size={52} />
          <b style={{ fontSize: 17 }}>Jev decision support</b>
          <span className="muted" style={{ fontSize: 12.5 }}>
            by TypeSafe
          </span>
        </div>
        <div className="igrp">
          <div className="foot2" style={{ fontSize: 13 }}>
            Optional decision support from TypeSafe's Jev model. Off by default; Flint's own behaviour stays in charge. Jev never approves a tool.
          </div>
        </div>
        <Grp cap="Connection" foot="The key is kept on the computer and never sent to the phone.">
          <IRow icon="x-key" label="TypeSafe API key" val="On the computer" onClick={later('Setting the API key')} />
        </Grp>
        <Grp cap="Features">
          <IRow label="Skill suggestions" val={cap(s?.jev?.skills)} onClick={set('jev.skills', null)} />
          <IRow label="Rerank retrieved sources" val={cap(s?.jev?.rerank)} onClick={set('jev.rerank', null)} />
        </Grp>
      </>
    ),
  ],
  extensions: ['Extensions', () => <OnComputer what="Plugins and extensions" />],
  localapi: [
    'Local API Server',
    (s) => (
      <>
        <Grp foot="Run an OpenAI-compatible server locally on the computer.">
          <IRow label="Local API Server" sw={s?.localApi.enabled ?? false} onClick={set('localApi.enabled', !s?.localApi.enabled)} />
        </Grp>
        <Grp cap="Server">
          <IRow label="Host" val={s?.localApi.host ?? '—'} />
          <IRow label="Port" val={s ? String(s.localApi.port) : '—'} />
          <IRow label="API prefix" val={s?.localApi.prefix ?? '—'} />
          <IRow label="CORS" sw={s?.localApi.cors ?? false} onClick={set('localApi.cors', !s?.localApi.cors)} />
          <IRow label="API key" val={s ? (s.localApi.hasKey ? 'Set' : 'Not set') : '—'} />
        </Grp>
      </>
    ),
  ],
  proxy: [
    'HTTPS Proxy',
    (s) => (
      <>
        <Grp>
          <IRow label="Proxy" sw={s?.proxy.enabled ?? false} onClick={set('proxy.enabled', !s?.proxy.enabled)} />
        </Grp>
        <Grp cap="Proxy URL" foot="The URL and port of your proxy server.">
          <IRow label={s?.proxy.url || 'Not set'} onClick={later('Editing the proxy')} />
        </Grp>
        <Grp>
          <IRow label="Verify SSL certificates" sw={s?.proxy.verifySsl ?? true} onClick={set('proxy.verifySsl', !s?.proxy.verifySsl)} />
          <IRow label="No proxy for" val={s?.proxy.noProxy || '—'} />
        </Grp>
      </>
    ),
  ],
  hardware: ['Hardware', () => <HardwarePage />],
  agenttools: [
    'Agent Tools',
    (s) => (
      <Grp foot="Give models a private scratch workspace for each conversation, plus memories and skills kept in your Flint data folder.">
        <IRow label="Enable Agent Tools" sw={s?.agentTools ?? false} onClick={set('agentTools.enabled', !s?.agentTools)} />
      </Grp>
    ),
  ],
  help: [
    'Help & feedback',
    () => (
      <Grp>
        <IRow icon="headset" label="Report a problem" onClick={() => toast('Report problems from Help on the computer')} />
        <IRow icon="news" label="What's new" onClick={later("What's new")} />
      </Grp>
    ),
  ],
  about: [
    'About Flint',
    (s) => (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 0' }}>
          <FlintMark size={72} />
          <b style={{ fontSize: 20 }}>Flint</b>
          <span className="muted">Version {s?.version ?? VERSION}</span>
        </div>
        <Grp>
          <IRow label="Phone app" val={VERSION} />
          <IRow label="Fork of Jan" val="janhq/jan" />
        </Grp>
      </>
    ),
  ],
  computer: ['Computer', () => <ComputerPage />],
  remote: ['Remote access', (s) => <RemotePage s={s} />],
  notifs: [
    'Notifications',
    () => (
      <>
        <Grp foot="Push notifications, even with Flint closed on this phone, come in a later update.">
          <IRow label="Show alerts while Flint is open" sw onClick={later('Turning alerts off')} />
        </Grp>
        <Grp cap="Notify me when">
          <IRow label="An approval is waiting" sw />
          <IRow label="A run finishes" sw />
          <IRow label="A Room is waiting for you" sw />
        </Grp>
      </>
    ),
  ],
  appearance: ['Appearance', () => <AppearancePage />],
  sound: [
    'Sound & haptics',
    () => (
      <Grp foot="Sounds and haptics for alerts on this phone arrive with push notifications, in a later update.">
        <IRow label="Haptics" sw={false} onClick={later('Haptics')} />
      </Grp>
    ),
  ],
  reasoning: ['Reasoning & thinking', () => <ReasoningPage />],
}

export default function SettingsSub({ sub }: { sub: string }) {
  const { data } = useRpc('settings.get', {})
  const page = PAGES[sub]
  return (
    <>
      <div className="top">
        <button type="button" className="navback" onClick={back}>
          <I n="chevl" />
          Settings
        </button>
        <div className="crumb" style={{ textAlign: 'center', marginRight: 70 }}>
          <b>{page?.[0] ?? 'Settings'}</b>
        </div>
      </div>
      <div className="scroll" style={{ padding: 0 }}>
        <div className="ios" style={{ paddingTop: 8 }}>
          {page ? page[1](data) : <Empty>Nothing here.</Empty>}
        </div>
      </div>
    </>
  )
}
