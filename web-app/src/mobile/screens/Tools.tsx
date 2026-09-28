import { TopMain } from '../shell/TopBar'
import { I } from '../ui/icons'
import { Empty, Loading, Sw } from '../ui/bits'
import { toast } from '../state/app'
import { useRpc } from '../state/rpc'

export default function Tools() {
  const { data, loading } = useRpc('tools.list', {})
  const servers = data?.servers ?? []
  return (
    <>
      <TopMain crumb="Engine" title="Tools & MCP" />
      <div className="scroll">
        <div className="ph">
          <h2>Tools &amp; MCP</h2>
          <p>What models and agents can use.</p>
        </div>
        {loading && !data && <Loading />}
        {data && servers.length === 0 && <Empty>No MCP servers are set up on the computer.</Empty>}
        {servers.length > 0 && (
          <div className="frame">
            {servers.map((s) => (
              <div key={s.name} className="mcard">
                <span className="trow" style={{ padding: 0, border: 0 }}>
                  <span className="tile">
                    <I n="server" style={{ color: 'var(--muted-foreground)' }} />
                  </span>
                </span>
                <span className="tx">
                  <b className="mono" style={{ fontSize: 12.5 }}>
                    {s.name}
                  </b>
                  <small style={{ fontFamily: 'var(--sans)' }}>{s.description ?? s.transport}</small>
                </span>
                <button
                  type="button"
                  aria-label={`${s.active ? 'Turn off' : 'Turn on'} ${s.name}`}
                  style={{ all: 'unset', cursor: 'pointer', display: 'flex' }}
                  onClick={() => toast('MCP servers are turned on and off on the computer')}
                >
                  <Sw on={s.active} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="ssec" style={{ paddingTop: 16 }}>
          Permissions
        </div>
        <div className="frame">
          <Empty>Standing grants are reviewed on the computer, in Settings › Permissions.</Empty>
        </div>
      </div>
    </>
  )
}
