import { useState } from 'react'
import { TopMain } from '../shell/TopBar'
import { I } from '../ui/icons'
import { FlintMark } from '../ui/bits'
import { Grp, IRow } from '../ui/ios'
import { go, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { reachLabel } from '../state/sessions'
import { THEME_WORD } from '../shell/labels'

const sub = (s: string) => () => go({ name: 'settings-sub', sub: s })
const onOff = (v: boolean | null | undefined) => (v === undefined || v === null ? undefined : v ? 'On' : 'Off')

export default function Settings() {
  const { data: s } = useRpc('settings.get', {})
  const status = useRpc('status', {})
  const computer = useApp((st) => st.computerName) ?? 'Your computer'
  const theme = useApp((st) => st.theme)
  const [q, setQ] = useState('')
  const loaded = status.data?.modelsLoaded ?? 0
  const match = (label: string) => !q || label.toLowerCase().includes(q.toLowerCase())
  const rows = <T extends { label: string }>(list: T[]) => list.filter((r) => match(r.label))

  const groups = [
    {
      cap: 'This phone',
      rows: rows([
        { label: 'Remote access', icon: 'signal-full' as const, val: 'On', onClick: () => go({ name: 'remote' }) },
        { label: 'Notifications', icon: 'bell' as const, onClick: sub('notifs') },
        { label: 'Sound & haptics', icon: 'x-play' as const, onClick: sub('sound') },
        { label: 'Reasoning & thinking', icon: 'zap' as const, onClick: sub('reasoning') },
      ]),
    },
    {
      cap: 'General',
      rows: rows([
        { label: 'General', icon: 'x-sliders' as const, onClick: sub('general') },
        { label: 'Appearance', icon: 'x-palette' as const, val: THEME_WORD[theme], onClick: sub('appearance') },
        { label: 'Assistants', icon: 'x-feather' as const, onClick: sub('assistants') },
        { label: 'Attachments', icon: 'x-clip' as const, onClick: sub('attachments') },
        { label: 'Memory', icon: 'x-brain' as const, onClick: sub('memory') },
        { label: 'Permissions', icon: 'x-shield' as const, onClick: sub('perms') },
        { label: 'Shortcuts', icon: 'command' as const, onClick: sub('shortcuts') },
      ]),
    },
    {
      cap: 'Models & tools',
      rows: rows([
        {
          label: 'Providers',
          icon: 'x-cube' as const,
          val: s ? `${s.providers.active} connected` : undefined,
          onClick: () => go({ name: 'models' }),
        },
        {
          label: 'MCP Servers',
          icon: 'flow' as const,
          exp: true,
          val: s ? `${s.mcpServers.active} on` : undefined,
          onClick: () => go({ name: 'tools' }),
        },
        { label: 'Web Search', icon: 'x-search' as const, val: onOff(s?.webSearch.enabled), onClick: sub('websearch') },
        { label: 'Claude Code', icon: 'claude' as const, exp: true, onClick: sub('claudecode') },
        {
          label: 'Jev',
          icon: 'jev' as const,
          exp: true,
          val: s?.jev ? (s.jev.skills === 'off' && s.jev.rerank === 'off' ? 'Off' : 'On') : undefined,
          onClick: sub('jev'),
        },
        { label: 'Extensions', icon: 'x-puzzle' as const, exp: true, onClick: sub('extensions') },
      ]),
    },
    {
      cap: 'Advanced',
      rows: rows([
        { label: 'Local API Server', icon: 'x-server' as const, val: onOff(s?.localApi.enabled), onClick: sub('localapi') },
        { label: 'HTTPS Proxy', icon: 'x-globe' as const, val: onOff(s?.proxy.enabled), onClick: sub('proxy') },
        { label: 'Hardware', icon: 'x-cpu' as const, onClick: sub('hardware') },
        { label: 'Agent Tools', icon: 'x-terminal' as const, val: onOff(s?.agentTools), onClick: sub('agenttools') },
      ]),
    },
    {
      cap: '',
      rows: rows([
        { label: 'Help & feedback', icon: 'headset' as const, onClick: sub('help') },
        { label: 'About Flint', icon: 'news' as const, val: s?.version, onClick: sub('about') },
      ]),
    },
  ]

  return (
    <>
      <TopMain crumb="Settings" title="Settings" />
      <div className="scroll" style={{ padding: 0 }}>
        <div className="ios">
          <h1>Settings</h1>
          <div className="isrch">
            <I n="search" />
            <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" />
          </div>
          {!q && (
            <button type="button" className="profile" onClick={sub('computer')}>
              <span className="big">
                <FlintMark />
              </span>
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <b>{computer}</b>
                <small>
                  Connected through {reachLabel()} · {loaded} {loaded === 1 ? 'model' : 'models'} loaded
                </small>
              </span>
              <I n="chevr" style={{ color: 'var(--subtle-foreground)' }} />
            </button>
          )}
          {groups
            .filter((g) => g.rows.length > 0)
            .map((g, i) => (
              <Grp key={i} cap={g.cap || undefined}>
                {g.rows.map((r) => (
                  <IRow key={r.label} {...r} />
                ))}
              </Grp>
            ))}
        </div>
      </div>
    </>
  )
}
