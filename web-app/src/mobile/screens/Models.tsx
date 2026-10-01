import { useEffect, useState } from 'react'
import type { DownloadTaskWire, RemoteModel } from '@/lib/remote/protocol'
import { providerLogo } from '@/lib/brandLogos'
import { TopMain } from '../shell/TopBar'
import { Avatar, Empty, Loading, Pills } from '../ui/bits'
import { go, useApp } from '../state/app'
import { I } from '../ui/icons'
import { invalidate, useRpc } from '../state/rpc'

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
    const t = setInterval(() => invalidate(keys), 1500)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, keys.join()])
}

const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)

/** A download's progress with its speed and time left (#55/#87). */
export function DownloadCard({ t }: { t: DownloadTaskWire }) {
  const pct = Math.round(t.progress * 100)
  const left = t.total && t.bytesPerSecond ? Math.max(0, (t.total - t.downloaded) / t.bytesPerSecond) : null
  const word = t.status === 'importing' ? 'Installing…' : t.status === 'verifying' ? 'Verifying…' : t.status === 'error' ? 'Failed' : t.status === 'paused' ? 'Paused' : `${pct}%`
  return (
    <div className="frame" style={{ padding: '10px 12px', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="download-card">
      <div className="kv"><b style={{ color: 'var(--foreground)' }}>{t.label}</b><span>{word}</span></div>
      <div className="meter"><i style={{ width: `${pct}%` }} /></div>
      <small className="muted">
        {t.total ? `${bytes(t.downloaded)} of ${bytes(t.total)}` : bytes(t.downloaded)}
        {t.bytesPerSecond ? ` · ${(t.bytesPerSecond / 1e6).toFixed(1)} MB/s` : ''}
        {left !== null ? ` · ${left < 60 ? `${Math.ceil(left)} s` : `${Math.ceil(left / 60)} min`} left` : ''}
      </small>
    </div>
  )
}

export default function Models() {
  const { data, loading } = useRpc('models.list', {})
  const status = useRpc('status', {})
  const downloads = useRpc('models.downloads', {})
  usePoll(['models.downloads'], (downloads.data?.tasks ?? []).some((t) => ACTIVE.includes(t.status)))
  const computer = useApp((s) => s.computerName) ?? 'your computer'
  const [filter, setFilter] = useState<'all' | 'local' | 'remote'>('all')
  const models = data?.models ?? []
  const providers = new Map<string, RemoteModel[]>()
  for (const m of models) providers.set(m.provider, [...(providers.get(m.provider) ?? []), m])
  const shown = models.filter((m) => (filter === 'all' ? true : filter === 'local' ? m.local : !m.local))
  return (
    <>
      <TopMain crumb="Engine" title="Models" />
      <div className="scroll">
        <div className="ph">
          <h2>Models</h2>
          <p>
            {models.length} available · {status.data?.modelsLoaded ?? 0} loaded on {computer}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button type="button" className="btn pri" style={{ flex: 1 }} onClick={() => go({ name: 'hf' })}>
            <I n="dl" size={14} />
            Browse Hugging Face
          </button>
        </div>
        {(downloads.data?.tasks ?? []).filter((t) => !['complete', 'cancelled'].includes(t.status)).map((t) => <DownloadCard key={t.id} t={t} />)}
        {loading && !data && <Loading />}
        {providers.size > 0 && <div className="ssec">Providers</div>}
        <div className="pgrid">
          {[...providers.entries()].map(([p, list]) => (
            <div key={p} className="pcard">
              <div className="top2">
                <ProviderTile provider={p} />
              </div>
              <b>{list[0].providerName ?? p}</b>
              <small>
                {list[0].local ? 'On this computer' : 'Remote'} · {list.length} {list.length === 1 ? 'model' : 'models'}
              </small>
              <span className="chip ok" style={{ alignSelf: 'flex-start' }}>
                <span className="d" />
                {list.some((m) => m.loaded) ? 'Running' : 'Connected'}
              </span>
            </div>
          ))}
        </div>
        <div className="ssec">Installed models</div>
        <Pills
          items={[
            { id: 'all', label: 'All' },
            { id: 'local', label: 'Local' },
            { id: 'remote', label: 'Remote' },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {data && shown.length === 0 ? (
          <Empty>No models here.</Empty>
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
                  {m.loaded ? 'Loaded' : m.local ? 'Ready' : 'Cloud'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
