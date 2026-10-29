import { useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { usePluginInstallForm } from '@/hooks/usePluginInstall'
import { newPluginOperationId } from '@/hooks/usePluginManager'
import {
  installPlugin,
  pluginErrorText,
  urlHost,
  type InstalledPlugin,
  type PluginSourceKind,
  type PluginSources,
} from '@/lib/pluginStore'
import { PluginAlert } from './PluginAlert'

type Props = {
  /**
   * The field values. Held by the tab, not here, so what was typed survives
   * leaving the panel and coming back, as it did before the form was split
   * out.
   */
  form: ReturnType<typeof usePluginInstallForm>
  sources: PluginSources | null
  /** The install landed; the tab refreshes and selects it. */
  onInstalled: (plugin: InstalledPlugin) => Promise<void>
  onBack: () => void
}

/**
 * Install-by-source form: local folder / git URL / marketplace name. Works
 * regardless of whether a global marketplace is configured (only the
 * "marketplace" kind depends on one). Owns its busy and error state; both
 * start clean each time the panel opens.
 */
export function InstallPluginForm({
  form,
  sources,
  onInstalled,
  onBack,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const {
    kind: installKind,
    setKind: setInstallKind,
    localPath,
    setLocalPath,
    gitUrl,
    setGitUrl,
    marketName,
    setMarketName,
    fieldError: installFieldError,
    setFieldError: setInstallFieldError,
    gitHost,
    chooseFolder,
    buildSource: buildInstallSource,
  } = form
  const [installBusy, setInstallBusy] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const gitDisabled = sources !== null && !sources.gitAvailable

  const submitInstall = async () => {
    if (installBusy) return
    setInstallFieldError(null)
    setInstallError(null)
    const source = buildInstallSource()
    if (!source) return
    const operationId = newPluginOperationId()
    setInstallBusy(true)
    try {
      const plugin = await installPlugin('', source, operationId, 'global')
      await onInstalled(plugin)
    } catch (e) {
      setInstallError(t('plugins:install.failed', { error: pluginErrorText(t, e) }))
    } finally {
      setInstallBusy(false)
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submitInstall()
      }}
    >
      <fieldset className="flex flex-col gap-2" disabled={installBusy}>
        <legend className="text-xs text-muted-foreground mb-1">
          {t('plugins:install.sourceLabel')}
        </legend>
        <RadioGroup
          value={installKind}
          onValueChange={(v) => {
            setInstallKind(v as PluginSourceKind)
            setInstallFieldError(null)
          }}
          className="gap-2"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem id="global-plugin-source-local" value="local" />
            <Label htmlFor="global-plugin-source-local">{t('plugins:install.local')}</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem
              id="global-plugin-source-git"
              value="git"
              disabled={gitDisabled}
            />
            <Label htmlFor="global-plugin-source-git">{t('plugins:install.git')}</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="global-plugin-source-marketplace" value="marketplace" />
            <Label htmlFor="global-plugin-source-marketplace">
              {t('plugins:install.marketplace')}
            </Label>
          </div>
        </RadioGroup>
      </fieldset>

      {installKind === 'local' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="global-plugin-local-path">{t('plugins:install.localPathLabel')}</Label>
          <div className="flex gap-2">
            <Input
              id="global-plugin-local-path"
              value={localPath}
              disabled={installBusy}
              placeholder={t('plugins:install.localPathPlaceholder')}
              onChange={(e) => {
                setLocalPath(e.target.value)
                setInstallFieldError(null)
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 shrink-0"
              disabled={installBusy}
              onClick={() => void chooseFolder()}
            >
              <FolderOpen size={14} />
              {t('plugins:install.chooseFolder')}
            </Button>
          </div>
        </div>
      )}

      {installKind === 'git' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="global-plugin-git-url">{t('plugins:install.gitUrlLabel')}</Label>
          <Input
            id="global-plugin-git-url"
            value={gitUrl}
            disabled={installBusy}
            placeholder={t('plugins:install.gitUrlPlaceholder')}
            onChange={(e) => {
              setGitUrl(e.target.value)
              setInstallFieldError(null)
            }}
          />
          <p className="text-xs text-muted-foreground">
            {gitHost
              ? t('plugins:install.gitNotice', { host: gitHost })
              : t('plugins:install.gitNoticeNoHost')}
          </p>
        </div>
      )}

      {installKind === 'marketplace' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="global-plugin-market-name">
            {t('plugins:install.marketplaceNameLabel')}
          </Label>
          <Input
            id="global-plugin-market-name"
            value={marketName}
            disabled={installBusy}
            onChange={(e) => {
              setMarketName(e.target.value)
              setInstallFieldError(null)
            }}
          />
          {sources?.marketplace ? (
            <p className="text-xs text-muted-foreground">
              {t('plugins:install.marketplaceNotice', { host: urlHost(sources.marketplace) })}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('plugins:browse.notConfigured')}
            </p>
          )}
        </div>
      )}

      {installFieldError && <PluginAlert>{installFieldError}</PluginAlert>}
      {installError && <PluginAlert>{installError}</PluginAlert>}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          {t('plugins:install.back')}
        </Button>
        <Button type="submit" size="sm" disabled={installBusy}>
          {installBusy && <Loader2 className="motion-safe:animate-spin" size={14} aria-hidden />}
          {t('plugins:install.submit')}
        </Button>
      </div>
    </form>
  )
}
