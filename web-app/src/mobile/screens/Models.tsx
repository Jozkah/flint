import { useEffect, useState } from 'react'
import type { DownloadTaskWire, RemoteModel } from '@/lib/remote/protocol'
import { providerLogo } from '@/lib/brandLogos'
import { TopMain } from '../shell/TopBar'
import { Avatar, Empty, Loading, Pills } from '../ui/bits'
import { go, useApp } from '../state/app'
import { I } from '../ui/icons'
import { invalidate, useRpc } from '../state/rpc'
import { t } from '../i18n'

function ProviderTile({ provider }: { provider: string }) {
  const logo = providerLogo(provider)
  return (
    <span className="logo sq" style={{ width: 32, height: 32, borderRadius: 9 }}>
      {logo ? <img src={logo.src} alt="" className={logo.mono ? 'mono' : undefined} /> : <b style={{ fontSize: 13 }}>{provider[0]?.toUpperCase()}</b>}
    </span>
  )
}

const ACTIVE = ['queued', 'downloading', 'verifying', 'importing']

/** Re-reads while something is moving: downloads report no events. */
function usePoll(keys: string[], on: boolean) {
  useEffect(() => {
    if (!on) return
    // A hidden page re-reads nothing; it catches up as soon as it is shown.
    const tick = () => {
      if (document.visibilityState !== 'hidden') invalidate(keys)
    }
    const timer = setInterval(tick, 1500)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, keys.join()])
}

const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)

/** A download's progress with its speed and time left (#55/#87). */
export function DownloadCard({ task }: { task: DownloadTaskWire }) {
  const pct = Math.round(task.progress * 100)
  const left = task.total && task.bytesPerSecond ? Math.max(0, (task.total - task.downloaded) / task.bytesPerSecond) : null
  const word = task.status === 'importing' ? t('models.installing') : task.status === 'verifying' ? t('models.verifying') : task.status === 'error' ? t('models.failed') : task.status === 'paused' ? t('models.paused') : `${pct}%`
  return (
    <div className="frame" style={{ padding: '10px 12px', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="download-card">
      <div className="kv"><b style={{ color: 'var(--foreground)' }}>{task.label}</b><span>{word}</span></div>
      <div className="meter"><i style={{ width: `${pct}%` }} /></div>
      <small className="muted">
        {task.total ? t('models.ofTotal', { done: bytes(task.downloaded), total: bytes(task.total) }) : bytes(task.downloaded)}
        {task.bytesPerSecond ? ` · ${(task.bytesPerSecond / 1e6).toFixed(1)} MB/s` : ''}
        {left !== null ? ` · ${left < 60 ? t('models.leftSeconds', { n: Math.ceil(left) }) : t('models.leftMinutes', { n: Math.ceil(left / 60) })}` : ''}
      </small>
    </div>
  )
}

export default function Models() {
  const { data, loading } = useRpc('models.list', {})
  const status = useRpc('status', {})
  const downloads = useRpc('models.downloads', {})
  usePoll(['models.downloads'], (downloads.data?.tasks ?? []).some((task) => ACTIVE.includes(task.status)))
  const computer = useApp((s) => s.computerName) ?? t('common.yourComputer')
  const [filter, setFilter] = useState<'all' | 'local' | 'remote'>('all')
  const models = data?.models ?? []
  const providers = new Map<string, RemoteModel[]>()
  for (const m of models) providers.set(m.provider, [...(providers.get(m.provider) ?? []), m])
  const shown = models.filter((m) => (filter === 'all' ? true : filter === 'local' ? m.local : !m.local))
  return (
    <>
      <TopMain crumb={t('models.crumb')} title={t('models.title')} />
      <div className="scroll">
        <div className="ph">
          <h2>{t('models.title')}</h2>
          <p>
            {t('models.summary', { available: models.length, loaded: status.data?.modelsLoaded ?? 0, computer })}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button type="button" className="btn pri" style={{ flex: 1 }} onClick={() => go({ name: 'hf' })}>
            <I n="dl" size={14} />
            {t('models.browseHf')}
          </button>
        </div>
        {(downloads.data?.tasks ?? []).filter((task) => !['complete', 'cancelled'].includes(task.status)).map((task) => <DownloadCard key={task.id} task={task} />)}
        {loading && !data && <Loading />}
        {providers.size > 0 && <div className="ssec">{t('models.providers')}</div>}
        <div className="pgrid">
          {[...providers.entries()].map(([p, list]) => (
            <div key={p} className="pcard">
              <div className="top2">
                <ProviderTile provider={p} />
              </div>
              <b>{list[0].providerName ?? p}</b>
              <small>
                {list[0].local ? t('models.onThisComputer') : t('models.remote')} · {t('models.count', { count: list.length })}
              </small>
              <span className="chip ok" style={{ alignSelf: 'flex-start' }}>
                <span className="d" />
                {list.some((m) => m.loaded) ? t('models.running') : t('models.connected')}
              </span>
            </div>
          ))}
        </div>
        <div className="ssec">{t('models.installed')}</div>
        <Pills
          items={[
            { id: 'all', label: t('models.filters.all') },
            { id: 'local', label: t('models.filters.local') },
            { id: 'remote', label: t('models.filters.remote') },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {data && shown.length === 0 ? (
          <Empty>{t('models.empty')}</Empty>
        ) : (
          <div className="frame">
            {shown.map((m) => (
              <div key={`${m.provider}/${m.id}`} className="mcard">
                <Avatar id={m.id} name={m.name} provider={m.provider} size={30} square />
                <span className="tx">
                  <b>{m.name}</b>
                  <small>
                    {m.id}
                  </small>
                </span>
                <span className={`chip${m.loaded ? ' ok' : ''}`}>
                  <span className="d" />
                  {m.loaded ? t('models.loaded') : m.local ? t('models.ready') : t('models.cloud')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
