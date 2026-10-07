import { useState } from 'react'
import { TopMain } from '../shell/TopBar'
import { I } from '../ui/icons'
import { FlintMark } from '../ui/bits'
import { Grp, IRow } from '../ui/ios'
import { go, useApp } from '../state/app'
import { useRpc } from '../state/rpc'
import { reachLabel } from '../state/sessions'
import { THEME_WORD } from '../shell/labels'
import { t } from '../i18n'

const sub = (s: string) => () => go({ name: 'settings-sub', sub: s })
const onOff = (v: boolean | null | undefined) => (v === undefined || v === null ? undefined : v ? t('common.on') : t('common.off'))

export default function Settings() {
  const { data: s } = useRpc('settings.get', {})
  const status = useRpc('status', {})
  const computer = useApp((st) => st.computerName) ?? t('common.yourComputerCap')
  const theme = useApp((st) => st.theme)
  const [q, setQ] = useState('')
  const loaded = status.data?.modelsLoaded ?? 0
  const match = (label: string) => !q || label.toLowerCase().includes(q.toLowerCase())
  const rows = <T extends { label: string }>(list: T[]) => list.filter((r) => match(r.label))

  const groups = [
    {
      cap: t('settings.groups.phone'),
      rows: rows([
        { label: t('settings.rows.remote'), icon: 'signal-full' as const, val: t('common.on'), onClick: () => go({ name: 'remote' }) },
        { label: t('settings.rows.notifications'), icon: 'bell' as const, onClick: sub('notifs') },
        { label: t('settings.rows.sound'), icon: 'x-play' as const, onClick: sub('sound') },
        { label: t('settings.rows.reasoning'), icon: 'zap' as const, onClick: sub('reasoning') },
      ]),
    },
    {
      cap: t('settings.groups.general'),
      rows: rows([
        { label: t('settings.rows.general'), icon: 'x-sliders' as const, onClick: sub('general') },
        { label: t('settings.rows.appearance'), icon: 'x-palette' as const, val: THEME_WORD[theme], onClick: sub('appearance') },
        { label: t('settings.rows.assistants'), icon: 'x-feather' as const, onClick: sub('assistants') },
        { label: t('settings.rows.attachments'), icon: 'x-clip' as const, onClick: sub('attachments') },
        { label: t('settings.rows.memory'), icon: 'x-brain' as const, onClick: sub('memory') },
        { label: t('settings.rows.permissions'), icon: 'x-shield' as const, onClick: sub('perms') },
        { label: t('settings.rows.shortcuts'), icon: 'command' as const, onClick: sub('shortcuts') },
      ]),
    },
    {
      cap: t('settings.groups.models'),
      rows: rows([
        {
          label: t('settings.rows.providers'),
          icon: 'x-cube' as const,
          val: s ? t('settings.connectedCount', { count: s.providers.active }) : undefined,
          onClick: () => go({ name: 'models' }),
        },
        {
          label: t('settings.rows.mcp'),
          icon: 'flow' as const,
          exp: true,
          val: s ? t('settings.onCount', { count: s.mcpServers.active }) : undefined,
          onClick: () => go({ name: 'tools' }),
        },
        { label: t('settings.rows.webSearch'), icon: 'x-search' as const, val: onOff(s?.webSearch.enabled), onClick: sub('websearch') },
        { label: t('settings.rows.claudeCode'), icon: 'claude' as const, exp: true, onClick: sub('claudecode') },
        {
          label: t('settings.rows.jev'),
          icon: 'jev' as const,
          exp: true,
          val: s?.jev ? (s.jev.skills === 'off' && s.jev.rerank === 'off' ? t('common.off') : t('common.on')) : undefined,
          onClick: sub('jev'),
        },
        { label: t('settings.rows.extensions'), icon: 'x-puzzle' as const, exp: true, onClick: sub('extensions') },
      ]),
    },
    {
      cap: t('settings.groups.advanced'),
      rows: rows([
        { label: t('settings.rows.localApi'), icon: 'x-server' as const, val: onOff(s?.localApi.enabled), onClick: sub('localapi') },
        { label: t('settings.rows.proxy'), icon: 'x-globe' as const, val: onOff(s?.proxy.enabled), onClick: sub('proxy') },
        { label: t('settings.rows.hardware'), icon: 'x-cpu' as const, onClick: sub('hardware') },
        { label: t('settings.rows.agentTools'), icon: 'x-terminal' as const, val: onOff(s?.agentTools), onClick: sub('agenttools') },
      ]),
    },
    {
      cap: '',
      rows: rows([
        { label: t('settings.rows.help'), icon: 'headset' as const, onClick: sub('help') },
        { label: t('settings.rows.about'), icon: 'news' as const, val: s?.version, onClick: sub('about') },
      ]),
    },
  ]

  return (
    <>
      <TopMain crumb={t('settings.title')} title={t('settings.title')} />
      <div className="scroll" style={{ padding: 0 }}>
        <div className="ios">
          <h1>{t('settings.title')}</h1>
          <div className="isrch">
            <I n="search" />
            <input placeholder={t('settings.search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('settings.searchLabel')} />
          </div>
          {!q && (
            <button type="button" className="profile" onClick={sub('computer')}>
              <span className="big">
                <FlintMark />
              </span>
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <b>{computer}</b>
                <small>
                  {t('settings.connectedThrough', { via: reachLabel(), count: loaded })}
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
