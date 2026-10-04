import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useVisualizeConfig } from '@/hooks/useVisualizeConfig'
import { WIDGET_MAX_HEIGHT_RANGE } from '@/lib/visualize/constants'

/**
 * Settings for inline widgets: whether the assistant is offered the two
 * widget tools, whether widgets may load libraries from two named CDNs, and
 * how tall one grows before it scrolls.
 */
export function VisualizeSettings() {
  const { t } = useTranslation()
  const enabled = useVisualizeConfig((s) => s.enabled)
  const setEnabled = useVisualizeConfig((s) => s.setEnabled)
  const allowCdn = useVisualizeConfig((s) => s.allowCdn)
  const setAllowCdn = useVisualizeConfig((s) => s.setAllowCdn)
  const maxHeight = useVisualizeConfig((s) => s.maxHeight)
  const setMaxHeight = useVisualizeConfig((s) => s.setMaxHeight)

  return (
    <Card title={t('settings:visualize.title')} data-testid="visualize-settings">
      <CardItem
        anchor="settings-agent-tools-visualize"
        title={t('settings:visualize.enabled')}
        description={t('settings:visualize.enabledDesc')}
        align="start"
        actions={
          <Switch
            data-testid="visualize-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        }
      />
      <CardItem
        title={t('settings:visualize.cdn')}
        description={t('settings:visualize.cdnDesc')}
        align="start"
        actions={
          <Switch
            data-testid="visualize-cdn"
            checked={allowCdn}
            disabled={!enabled}
            onCheckedChange={setAllowCdn}
          />
        }
      />
      <CardItem
        title={t('settings:visualize.maxHeight')}
        description={t('settings:visualize.maxHeightDesc')}
        actions={
          <Input
            type="number"
            min={WIDGET_MAX_HEIGHT_RANGE.min}
            max={WIDGET_MAX_HEIGHT_RANGE.max}
            step={40}
            aria-label={t('settings:visualize.maxHeight')}
            data-testid="visualize-max-height"
            className="w-[90px] text-right tabular-nums"
            disabled={!enabled}
            defaultValue={maxHeight}
            key={maxHeight}
            onBlur={(e) => setMaxHeight(Number(e.currentTarget.value))}
          />
        }
      />
    </Card>
  )
}
