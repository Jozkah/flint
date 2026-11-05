import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { BrandMark } from '@/containers/engine/BrandMark'
import { LiveChart } from '@/containers/engine/LiveChart'
import { modelLogo } from '@/lib/brandLogos'
import { formatTps } from '@/lib/engineModels'
import { formatBytes, getProviderTitle } from '@/lib/utils'

/** One loaded local model on the overview tab, with its speed against the
 * fastest loaded model and an unload button. */
export function LoadedModelRow({
  provider,
  model,
  fileSize,
  speedAvg,
  maxSpeed,
  series,
  onUnload,
}: {
  provider: ProviderObject
  model: Model
  fileSize: number | undefined
  /** Average speed, or undefined when no reply has been timed yet. */
  speedAvg: number | undefined
  maxSpeed: number
  series: number[]
  onUnload: () => void
}) {
  const { t } = useTranslation()
  const speed = speedAvg === undefined ? undefined : { avg: speedAvg }
  return (
    <div
      key={`${provider.provider}:${model.id}`}
      data-testid={`loaded-row-${model.id}`}
      className="flex items-center gap-3 border-b border-dashed border-border py-3 last:border-b-0"
    >
      <BrandMark
        logo={modelLogo(model.id, provider.provider)}
        name={model.name || model.id}
        size={34}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <b className="truncate text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
          {model.name || model.id}
        </b>
        <small className="truncate text-xs text-muted-foreground">
          {[
            getProviderTitle(provider.provider),
            fileSize ? formatBytes(fileSize) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </small>
        {maxSpeed > 0 && speed && (
          // Average speed against the fastest loaded model:
          // named and exposed as a progressbar (C147/C150).
          <span
            role="progressbar"
            aria-label={t('engine:loaded.speedBar')}
            aria-valuemin={0}
            aria-valuemax={Math.round(maxSpeed)}
            aria-valuenow={Math.round(speed.avg)}
            aria-valuetext={formatTps(speed.avg)}
            title={`${t('engine:loaded.speedBar')}: ${formatTps(speed.avg)}`}
            className="h-1.5 w-full overflow-hidden rounded-full bg-track"
          >
            <i
              className="block h-full rounded-full bg-grad motion-safe:animate-draw-x"
              style={{ width: `${(speed.avg / maxSpeed) * 100}%` }}
            />
          </span>
        )}
      </div>
      <div className="flex w-[110px] shrink-0 flex-col items-end gap-0.5 max-sm:hidden">
        {series.length > 1 && (
          <LiveChart series={series} compact format={formatTps} />
        )}
        {series.length > 0 && (
          <small className="text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground tabular-nums">
            {formatTps(series[series.length - 1])}
          </small>
        )}
        <small className="text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground tabular-nums">
          {speed ? formatTps(speed.avg) : t('engine:speed.noneYet')}
        </small>
      </div>
      <Button
        variant="surface"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={onUnload}
      >
        {t('engine:loaded.unload')}
      </Button>
    </div>
  )
}
