import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import EnablementGrid from '@/containers/extensions/EnablementGrid'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { InstalledPlugin, PluginDetails } from '@/lib/pluginStore'
import { PluginAlert } from './PluginAlert'

type Props = {
  /** The selected plugin; undefined shows the pick-one hint. */
  plugin: InstalledPlugin | undefined
  /** Loaded details, possibly for a previously selected plugin. */
  details: PluginDetails | null
  detailsError: string | null
  toggling: boolean
  toggleError: string | null
  removeError: string | null
  updateError: string | null
  /** Id of the plugin being updated, if any. */
  updating: string | null
  sourceLabel: (p: InstalledPlugin) => string
  onToggle: (enabled: boolean) => void
  onUpdate: (details: PluginDetails) => void
  onRemove: (details: PluginDetails) => void
}

/** The side panel for one installed plugin: state, provenance, enablement. */
export function PluginDetailsPane({
  plugin,
  details,
  detailsError,
  toggling,
  toggleError,
  removeError,
  updateError,
  updating,
  sourceLabel,
  onToggle,
  onUpdate,
  onRemove,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  if (!plugin) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        {t('plugins:pickOne')}
      </div>
    )
  }
  const switchId = `plugin-enabled-${plugin.id}`
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground break-words">
            {plugin.name}{' '}
            <span className="text-xs text-muted-foreground">
              {t('plugins:version', { version: plugin.version })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground break-words">
            {plugin.description || t('plugins:details.noDescription')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Label htmlFor={switchId} className="text-xs">
            {plugin.enabled ? t('plugins:state.enabled') : t('plugins:state.disabled')}
          </Label>
          <Switch
            id={switchId}
            checked={plugin.enabled}
            disabled={toggling}
            aria-label={t('plugins:toggle.label', { name: plugin.name })}
            onCheckedChange={onToggle}
          />
        </div>
      </div>
      {toggleError && <PluginAlert>{toggleError}</PluginAlert>}
      {removeError && <PluginAlert>{removeError}</PluginAlert>}
      {updateError && <PluginAlert>{updateError}</PluginAlert>}
      {detailsError ? (
        <PluginAlert>{t('plugins:details.failed', { error: detailsError })}</PluginAlert>
      ) : !details || details.id !== plugin.id ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="motion-safe:animate-spin" size={12} aria-hidden />
          {t('plugins:details.loading')}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1.5 text-xs [&_dd]:font-mono [&_dd]:text-fg-2">
            <dt className="text-muted-foreground">{t('plugins:source.label')}</dt>
            <dd className="break-all">
              {sourceLabel(details)}
              {details.source ? `: ${details.source}` : ''}
            </dd>
            {details.commitSha && (
              <>
                <dt className="text-muted-foreground">{t('plugins:details.commit')}</dt>
                <dd className="break-all font-mono">{details.commitSha.slice(0, 12)}</dd>
              </>
            )}
            {details.pinnedSha && (
              <>
                <dt className="text-muted-foreground">{t('plugins:details.pinned')}</dt>
                <dd className="break-all font-mono">{details.pinnedSha.slice(0, 12)}</dd>
              </>
            )}
            {details.marketplace && (
              <>
                <dt className="text-muted-foreground">{t('plugins:details.marketplace')}</dt>
                <dd className="break-all">{details.marketplace}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{t('plugins:details.installedPath')}</dt>
            <dd className="break-all">{details.installedPath}</dd>
          </dl>
          <div>
            <div className="mb-1.5 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium uppercase text-subtle-foreground">
              {t('common:extensionsManager.enablement.title', undefined) ?? 'Enabled on'}
            </div>
            <EnablementGrid kind="plugin" id={plugin.id} />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t('common:extensionsManager.enablement.pluginNote', undefined) ??
                "Governs this plugin's skills, subagents and slash commands on each surface."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(details.sourceKind === 'git' || details.sourceKind === 'marketplace') && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={updating !== null}
                onClick={() => onUpdate(details)}
              >
                {updating === details.id ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden />
                ) : (
                  <RefreshCw size={14} aria-hidden />
                )}
                {updating === details.id ? t('plugins:update.running') : t('plugins:update.button')}
              </Button>
            )}
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={() => onRemove(details)}
            >
              <Trash2 size={14} aria-hidden />
              {t('plugins:remove.button')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
