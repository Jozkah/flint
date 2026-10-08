import { useState } from 'react'
import { TopMain } from '../shell/TopBar'
import { I } from '../ui/icons'
import { Empty, Loading } from '../ui/bits'
import { go, openSheet } from '../state/app'
import { Media } from '../ui/studio'
import { useRpc } from '../state/rpc'
import { ago } from '../ui/format'
import { t } from '../i18n'

/** What Cowork runs and Studio produced, as the desktop's Library lists it. Opening a
 * file happens on the computer; a row goes to the session that wrote it. */
export default function Library() {
  const { data, loading, error } = useRpc('library.list', {})
  const [q, setQ] = useState('')
  const items = (data?.items ?? []).filter(
    (a) => !q || `${a.title} ${a.path} ${a.sessionTitle}`.toLowerCase().includes(q.toLowerCase())
  )
  return (
    <>
      <TopMain crumb={t('common.workspace')} title={t('library.title')} />
      <div className="scroll">
        <div className="ph">
          <h2>{t('library.title')}</h2>
          <p>{t('library.intro')}</p>
        </div>
        <div className="sin" style={{ marginBottom: 10 }}>
          <I n="search" />
          <input placeholder={t('library.search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('library.search')} />
        </div>
        {loading && !data && <Loading />}
        {error && !data && <Empty>{error.message}</Empty>}
        {data && (
          <div className="frame" data-testid="library-list">
            {items.length === 0 ? (
              <Empty icon={<I n="book" size={20} />}>{data.items.length ? t('library.noMatch') : t('library.empty')}</Empty>
            ) : (
              items.map((a) => (
                <button
                  key={`${a.sessionId}:${a.path}`}
                  type="button"
                  className="row"
                  onClick={() => (a.studio ? openSheet('studioitem', { item: a.studio }) : go({ name: 'cowork', id: a.sessionId }))}
                >
                  {a.studio ? (
                    <span className="gi" style={{ width: 34, height: 34, flex: 'none', borderRadius: 7 }} aria-hidden>
                      <Media item={a.studio} />
                    </span>
                  ) : (
                    <I n="file" />
                  )}
                  <span className="tx">
                    <b>{a.title}</b>
                    <small>
                      {a.group} · {a.label} · {a.sessionTitle} · {ago(a.updatedAt)}
                    </small>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </>
  )
}
