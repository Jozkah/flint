import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Puzzle } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SystemPageHeader } from '@/containers/SystemPageHeader'
import PluginsTab from '@/containers/extensions/PluginsTab'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.extensions as any)({
  component: ExtensionsPage,
})

type ExtensionsTab = 'plugins' | 'skills'

/** Scope the extensions views operate over. Only 'global' is wired for now. */
type ExtensionsScope = 'global' | 'project'

function ExtensionsPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<ExtensionsTab>('plugins')
  const [scope, setScope] = useState<ExtensionsScope>('global')

  const tabClass = (active: boolean) =>
    cn(
      'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors',
      active
        ? 'text-foreground border-b-2 border-primary'
        : 'text-muted-foreground hover:text-foreground border-b-2 border-transparent'
    )

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background">
      <SystemPageHeader
        title={t('common:appRail.extensions')}
        icon={<Puzzle className="size-4" />}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3 md:p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 border-b border-border" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'plugins'}
              className={tabClass(tab === 'plugins')}
              onClick={() => setTab('plugins')}
              data-testid="extensions-tab-plugins"
            >
              {t('common:extensions.plugins')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'skills'}
              className={tabClass(tab === 'skills')}
              onClick={() => setTab('skills')}
              data-testid="extensions-tab-skills"
            >
              {t('common:extensions.skills')}
            </button>
          </div>
          <div
            role="group"
            aria-label={t('common:extensions.scope')}
            className="flex items-center gap-0.5 rounded-md bg-sunken p-0.5"
          >
            {(['global', 'project'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
                className={cn(
                  'h-7 shrink-0 cursor-pointer rounded-[5px] px-2.5 text-[13px] font-medium transition-colors',
                  scope === s
                    ? 'bg-card text-foreground shadow-[0_0_0_1px_var(--border)]'
                    : 'text-ink-2 hover:text-foreground'
                )}
              >
                {t(`common:extensions.scope${s === 'global' ? 'Global' : 'Project'}`)}
              </button>
            ))}
          </div>
        </div>

        {tab === 'plugins' ? (
          <div
            className="flex flex-1 min-h-0 flex-col gap-1 rounded-lg border border-border bg-card p-5"
            data-testid="extensions-panel-plugins"
          >
            <PluginsTab />
          </div>
        ) : (
          <div
            className="flex flex-1 flex-col items-start gap-1 rounded-lg border border-border bg-card p-5"
            data-testid="extensions-panel-skills"
          >
            <h2 className="text-sm font-semibold text-foreground">
              {t('common:extensions.skills')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('common:extensions.skillsPlaceholder')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
