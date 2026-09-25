import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SystemPageHeader } from '@/containers/SystemPageHeader'
import PluginsTab from '@/containers/extensions/PluginsTab'
import SkillsTab from '@/containers/extensions/SkillsTab'
import ImportFromClaudeCodeDialog from '@/containers/extensions/ImportFromClaudeCodeDialog'
import { ExtensionIcon } from '@/containers/extensions/ExtensionIcon'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Chip } from '@/components/ui/chip'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { EnginePage, PageHead } from '@/containers/engine/EngineKit'
import { ExtensionManager } from '@/lib/extension'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.extensions as any)({
  component: ExtensionsPage,
})

type ExtensionsTab = 'plugins' | 'skills' | 'engine' | 'marketplace'

/** Scope the extensions views operate over. Only 'global' is wired for now. */
type ExtensionsScope = 'global' | 'project'

function ExtensionsPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<ExtensionsTab>('plugins')
  const [scope, setScope] = useState<ExtensionsScope>('global')
  const [importOpen, setImportOpen] = useState(false)
  // Bumped by the Install button; the plugins view opens its install panel.
  const [installRequest, setInstallRequest] = useState(0)

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <SystemPageHeader title={t('common:appRail.extensions')} />
      <EnginePage testId="extensions-page">
        <PageHead
          title={t('common:appRail.extensions')}
          description={t('engine:extensions.description')}
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                data-testid="extensions-import-cc-button"
                onClick={() => setImportOpen(true)}
              >
                {t('common:extensionsManager.import.button')}
              </Button>
              <Button
                size="sm"
                className="pointer-coarse:h-11"
                data-testid="extensions-install-plugin-button"
                onClick={() => {
                  if (tab !== 'plugins' && tab !== 'marketplace') setTab('plugins')
                  setInstallRequest((n) => n + 1)
                }}
              >
                <Icon name="x-plus-w" size={14} />
                {t('plugins:installButton')}
              </Button>
            </>
          }
        />

        <div className="flex flex-wrap items-center gap-3 motion-safe:animate-rise-in [animation-delay:80ms]">
          <Segmented<ExtensionsTab>
            className="w-[520px] max-w-full"
            aria-label={t('common:appRail.extensions')}
            value={tab}
            onValueChange={setTab}
            options={[
              {
                value: 'plugins',
                label: t('common:extensionsManager.plugins'),
                testId: 'extensions-tab-plugins',
              },
              {
                value: 'skills',
                label: t('common:extensionsManager.skills'),
                testId: 'extensions-tab-skills',
              },
              {
                value: 'engine',
                label: t('engine:extensions.engine'),
                testId: 'extensions-tab-engine',
              },
              {
                value: 'marketplace',
                label: t('engine:extensions.marketplace'),
                testId: 'extensions-tab-marketplace',
              },
            ]}
          />
          <span className="flex-1" />
          {tab !== 'engine' && (
            <Segmented<ExtensionsScope>
              className="w-[180px]"
              aria-label={t('common:extensionsManager.scope')}
              value={scope}
              onValueChange={setScope}
              options={[
                {
                  value: 'global',
                  label: t('common:extensionsManager.scopeGlobal'),
                },
                {
                  value: 'project',
                  label: t('common:extensionsManager.scopeProject'),
                },
              ]}
            />
          )}
        </div>

        <ImportFromClaudeCodeDialog open={importOpen} onOpenChange={setImportOpen} />

        {tab === 'plugins' || tab === 'marketplace' ? (
          <div
            className="flex min-h-0 flex-col"
            data-testid={
              tab === 'plugins'
                ? 'extensions-panel-plugins'
                : 'extensions-panel-marketplace'
            }
          >
            <PluginsTab
              hideToolbar
              view={tab === 'plugins' ? 'installed' : 'marketplace'}
              installRequest={installRequest}
            />
          </div>
        ) : tab === 'skills' ? (
          <div
            className="flex min-h-0 flex-col"
            data-testid="extensions-panel-skills"
          >
            <SkillsTab />
          </div>
        ) : (
          <div data-testid="extensions-panel-engine">
            <EngineExtensions />
          </div>
        )}
      </EnginePage>
    </div>
  )
}

/**
 * The extensions Flint itself is built from (assistant, conversation store,
 * inference engines, retrieval). Read-only: they ship with the app and are
 * always on, so the cards say what each does and which version is running.
 */
function EngineExtensions() {
  const { t } = useTranslation()
  const extensions = useMemo(() => {
    try {
      return ExtensionManager.getInstance().listExtensions()
    } catch {
      return []
    }
  }, [])

  if (extensions.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-muted-foreground">
        {t('engine:extensions.engineEmpty')}
      </p>
    )
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,290px),1fr))] gap-4">
      {extensions.map((ext, i) => {
        const name = ext.productName ?? ext.name
        return (
          <Frame
            key={ext.name}
            className="motion-safe:animate-rise-in"
            style={{ animationDelay: `${60 + i * 45}ms` }}
          >
            <FrameHeader
              icon={<ExtensionIcon name={name} size={26} className="rounded-lg" />}
              title={name}
              actions={
                ext.version ? (
                  <Chip mono className="h-5">
                    v{ext.version}
                  </Chip>
                ) : undefined
              }
            />
            <FrameBody className="gap-2.5 p-3">
              <p className="m-0 text-[12.5px] leading-normal text-muted-foreground">
                {ext.description}
              </p>
              <div className="flex items-center justify-between gap-2 text-xs text-subtle-foreground">
                <span>{t('engine:extensions.builtIn')}</span>
                <Chip tone="ok" dot>
                  {t('engine:extensions.active')}
                </Chip>
              </div>
            </FrameBody>
          </Frame>
        )
      })}
    </div>
  )
}
