import { useState } from 'react'
import type { RemoteModel } from '@/lib/remote/protocol'
import { providerLogo } from '@/lib/brandLogos'
import { TopMain } from '../shell/TopBar'
import { Avatar, Empty, Loading, Pills } from '../ui/bits'
import { useApp } from '../state/app'
import { useRpc } from '../state/rpc'

function ProviderTile({ provider }: { provider: string }) {
  const logo = providerLogo(provider)
  return (
    <span className="logo sq" style={{ width: 32, height: 32, borderRadius: 9 }}>
      {logo ? <img src={logo.src} alt="" className={logo.mono ? 'mono' : undefined} /> : <b style={{ fontSize: 13 }}>{provider[0]?.toUpperCase()}</b>}
    </span>
  )
}

export default function Models() {
  const { data, loading } = useRpc('models.list', {})
  const status = useRpc('status', {})
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
