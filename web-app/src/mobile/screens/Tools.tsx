import { TopMain } from '../shell/TopBar'
import { I } from '../ui/icons'
import { Empty, Loading, Sw } from '../ui/bits'
import { toast } from '../state/app'
import { useRpc } from '../state/rpc'
import { t } from '../i18n'

export default function Tools() {
  const { data, loading } = useRpc('tools.list', {})
  const servers = data?.servers ?? []
  return (
    <>
      <TopMain crumb={t('models.crumb')} title={t('tools.title')} />
      <div className="scroll">
        <div className="ph">
          <h2>{t('tools.title')}</h2>
          <p>{t('tools.intro')}</p>
        </div>
        {loading && !data && <Loading />}
        {data && servers.length === 0 && <Empty>{t('tools.empty')}</Empty>}
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
                  aria-label={t(s.active ? 'tools.turnOff' : 'tools.turnOn', { name: s.name })}
                  style={{ all: 'unset', cursor: 'pointer', display: 'flex' }}
                  onClick={() => toast(t('tools.toggleOnComputer'))}
                >
                  <Sw on={s.active} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="ssec" style={{ paddingTop: 16 }}>
          {t('tools.permissions')}
        </div>
        <div className="frame">
          <Empty>{t('tools.grants')}</Empty>
        </div>
      </div>
    </>
  )
}
