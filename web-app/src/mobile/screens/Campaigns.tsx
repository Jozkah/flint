import { useEffect } from 'react'
import { TopBack } from '../shell/TopBar'
import { Empty, Loading } from '../ui/bits'
import { I } from '../ui/icons'
import { ago } from '../ui/format'
import { go } from '../state/app'
import { useRpc } from '../state/rpc'
import { RemoteCallError } from '../api/client'
import { headlineOf, headlineText, modelOf, sortCampaigns } from '../state/campaigns'
import { t } from '../i18n'

const POLL_MS = 5_000

export default function Campaigns() {
  const list = useRpc('campaigns.list', {})
  const { reload } = list
  useEffect(() => {
    const timer = setInterval(reload, POLL_MS)
    return () => clearInterval(timer)
  }, [reload])
  const campaigns = sortCampaigns(list.data?.campaigns ?? [])
  const old = list.error instanceof RemoteCallError && ['unknown_method', 'not_implemented'].includes(list.error.code)
  return (
    <>
      <TopBack crumb={t('campaigns.crumb')} title={t('campaigns.title')} />
      <div className="scroll" data-testid="campaigns-list">
        {list.loading && !list.data && <Loading />}
        {list.error && !list.data && <Empty>{old ? t('campaigns.unsupported') : list.error.message}</Empty>}
        {list.data && campaigns.length === 0 && (
          <Empty icon={<I n="flow" size={22} />}>
            <b>{t('campaigns.none')}</b>
            <br />
            {t('campaigns.noneHint')}
          </Empty>
        )}
        {campaigns.map((c) => {
          const h = headlineOf(modelOf(c))
          const attention = h.key === 'attention' || h.key === 'review'
          const live = ['approved', 'running', 'reviewing', 'merging'].includes(c.status) && !attention
          return (
            <button
              key={c.id}
              type="button"
              className="row cprow"
              data-testid="campaign-row"
              onClick={() => go({ name: 'campaign', id: c.id })}
            >
              <span className={`sd ${attention ? 'wait' : live ? 'run' : ''}`} />
              <span className="tx">
                <b>{c.title || t('common.untitled')}</b>
                <small>
                  {headlineText(h)} · {ago(Date.parse(c.updatedAt) || Date.now())}
                </small>
              </span>
              <span className="cnt">{t('campaigns.tasksDone', { done: h.done, total: h.total })}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}
