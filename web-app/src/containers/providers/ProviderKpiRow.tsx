import { Icon } from '@/components/ui/icon'
import { KpiRow, KpiTile } from '@/containers/engine/EngineKit'
import { formatTps } from '@/lib/engineModels'
import { formatBytes } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Props = {
  isEngineProvider: boolean
  /** Engine providers. */
  chatModelCount: number
  embeddingModelCount: number
  loadedCount: number
  modelCount: number
  diskBytes: number
  localFileCount: number
  /** Remote providers. */
  allModelCount: number
  repliesToday: number
  replySampleCount: number
  keyCount: number
  averageSpeed: number | undefined
}

export function ProviderKpiRow({
  isEngineProvider,
  chatModelCount,
  embeddingModelCount,
  loadedCount,
  modelCount,
  diskBytes,
  localFileCount,
  allModelCount,
  repliesToday,
  replySampleCount,
  keyCount,
  averageSpeed,
}: Props) {
  const { t } = useTranslation()
  return (
    <KpiRow>
      {isEngineProvider ? (
        <>
          <KpiTile
            title={t('engine:kpi.installed')}
            icon={<Icon name="x-cube" />}
            value={chatModelCount}
            sub={t('engine:kpi.embeddingSub', {
              count: embeddingModelCount,
            })}
            delay={40}
          />
          <KpiTile
            title={t('engine:kpi.loaded')}
            icon={<Icon name="x-cpu" />}
            value={loadedCount}
            sub={t('engine:kpi.loadedSub', {
              count: modelCount,
            })}
            delay={80}
          />
          <KpiTile
            title={t('engine:kpi.disk')}
            icon={<Icon name="x-disk" />}
            value={diskBytes > 0 ? formatBytes(diskBytes) : '—'}
            sub={t('engine:kpi.diskSub', {
              count: localFileCount,
            })}
            delay={120}
          />
        </>
      ) : (
        <>
          <KpiTile
            title={t('providers:models')}
            icon={<Icon name="x-cube" />}
            value={allModelCount}
            sub={t('engine:kpi.addedSub')}
            delay={40}
          />
          <KpiTile
            title={t('engine:kpi.repliesToday')}
            icon={<Icon name="x-activity" />}
            value={repliesToday}
            sub={t('engine:kpi.repliesSub', {
              count: replySampleCount,
            })}
            delay={80}
          />
          <KpiTile
            title={t('engine:kpi.apiKeys')}
            icon={<Icon name="x-key" />}
            value={keyCount}
            sub={
              keyCount > 1
                ? t('engine:kpi.fallbackSub', { count: keyCount - 1 })
                : t('engine:kpi.noFallbackSub')
            }
            delay={120}
          />
        </>
      )}
      <KpiTile
        title={t('engine:kpi.avgSpeed')}
        icon={<Icon name="zap" />}
        value={averageSpeed !== undefined ? formatTps(averageSpeed) : '—'}
        sub={
          averageSpeed !== undefined
            ? t('engine:kpi.repliesSub', { count: replySampleCount })
            : t('engine:kpi.fastestNone')
        }
        delay={160}
      />
    </KpiRow>
  )
}
