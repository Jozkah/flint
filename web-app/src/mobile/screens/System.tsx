import { TopMain } from '../shell/TopBar'
import { I } from '../ui/icons'
import { Empty, Kv, Loading } from '../ui/bits'
import { useApp } from '../state/app'
import { useRpc } from '../state/rpc'

const gb = (mb: number) => `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`

function Meter({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="card2" style={{ marginBottom: 8 }}>
      <Kv k={label} v={value} />
      <div className="meter">
        <i style={{ width: `${Math.min(100, Math.max(0, pct))}%`, ...(pct > 90 ? { background: 'var(--warning)' } : {}) }} />
      </div>
    </div>
  )
}

export default function System() {
  const { data, loading, error, reload } = useRpc('system.info', {})
  const computer = useApp((s) => s.computerName)
  return (
    <>
      <TopMain
        crumb="Engine"
        title="System Monitor"
        extra={
          <button type="button" className="ib" onClick={reload} aria-label="Refresh">
            <I n="refresh" />
          </button>
        }
      />
      <div className="scroll">
        {loading && !data && <Loading />}
        {error && !data && <Empty>{error.message}</Empty>}
        {data && (
          <>
            <div className="ph">
              <h2>{computer ?? data.computerName ?? 'Your computer'}</h2>
              <p>
                {[data.os, data.gpus[0] ? `${data.gpus[0].name} ${gb(data.gpus[0].vram)}` : '', data.ram.total ? `${gb(data.ram.total)} RAM` : '']
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <Meter label="CPU" value={`${Math.round(data.cpu.usage)}%`} pct={data.cpu.usage} />
            {data.ram.total > 0 && (
              <Meter label="RAM" value={`${gb(data.ram.used)} / ${gb(data.ram.total)}`} pct={(data.ram.used / data.ram.total) * 100} />
            )}
            {data.gpus.map((g) => (
              <Meter
                key={g.name}
                label={`VRAM · ${g.name}`}
                value={g.used !== null ? `${gb(g.used)} / ${gb(g.vram)}` : gb(g.vram)}
                pct={g.used !== null && g.vram ? (g.used / g.vram) * 100 : 0}
              />
            ))}
            <div className="card2">
              <h4>
                <I n="server" />
                Local API server
              </h4>
              <Kv
                k="Status"
                v={
                  <span style={{ color: data.localApi.running ? 'var(--success)' : undefined }}>
                    {data.localApi.running ? `On · ${data.localApi.host}:${data.localApi.port}` : 'Off'}
                  </span>
                }
              />
            </div>
          </>
        )}
      </div>
    </>
  )
}
