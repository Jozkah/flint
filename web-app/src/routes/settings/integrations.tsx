import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import {
  SettingsTabStrip,
  useSettingsTab,
  type SettingsTab,
} from '@/containers/SettingsTabs'
import { ClaudeCodeSettings } from '@/containers/ClaudeCodeSettings'
import { ExtensionsSettings } from '@/containers/ExtensionsSettings'
import { JevSettingsCard } from '@/containers/JevSettingsCard'
import { TypeSafeMark } from '@/components/ui/TypeSafeMark'
import { isPlatformTauri } from '@/lib/platform/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

const INTEGRATION_TABS = ['claude-code', 'jev', 'extensions'] as const
type IntegrationTab = (typeof INTEGRATION_TABS)[number]

type IntegrationsSearch = { tab?: IntegrationTab }


export const Route = createFileRoute(route.settings.integrations)({
  component: IntegrationsSettings,
  validateSearch: (search: Record<string, unknown>): IntegrationsSearch =>
    INTEGRATION_TABS.includes(search.tab as IntegrationTab)
      ? { tab: search.tab as IntegrationTab }
      : {},
})

/** Claude Code and Extensions drive this machine; the browser client of
 * `flint serve` shows only Jev. */
const DESKTOP_ONLY_TABS: ReadonlySet<IntegrationTab> = new Set([
  'claude-code',
  'extensions',
])

function IntegrationsSettings() {
  const { t } = useTranslation()
  const { tab: requested } = Route.useSearch() as IntegrationsSearch
  const desktop = isPlatformTauri()
  const all: SettingsTab<IntegrationTab>[] = [
    {
      id: 'claude-code',
      // The brand marks the sidebar used to show beside these pages.
      label: (
        <span className="inline-flex items-center gap-1.5">
          <img
            src="/images/logos/claude-color.svg"
            width={14}
            height={14}
            alt=""
            className="size-3.5"
          />
          {t('common:claude_code')}
        </span>
      ),
      anchors: ['settings-integrations-claude-code-*'],
    },
    {
      id: 'jev',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <TypeSafeMark size={14} />
          {t('common:jev.tab')}
        </span>
      ),
      anchors: ['settings-integrations-jev-*'],
    },
    { id: 'extensions', label: t('common:extensions') },
  ]
  const tabs = all.filter((tab) => desktop || !DESKTOP_ONLY_TABS.has(tab.id))
  const initial = tabs.some((tab) => tab.id === requested)
    ? requested
    : undefined
  const [tab, setTab] = useSettingsTab(tabs, initial)

  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={t('common:integrations')} />
      <SettingsPageBody
        title={t('common:integrations')}
        description={t('settings:pageDesc.integrations')}
        actions={
          tabs.length > 1 ? (
            <SettingsTabStrip
              tabs={tabs}
              value={tab}
              onChange={setTab}
              label={t('common:integrations')}
            />
          ) : undefined
        }
      >
        {tab === 'claude-code' && <ClaudeCodeSettings />}
        {tab === 'jev' && (
          <JevSettingsCard
            anchors={{
              key: 'settings-integrations-jev-key',
              skills: 'settings-integrations-jev-skills',
              rerank: 'settings-integrations-jev-rerank',
            }}
          />
        )}
        {tab === 'extensions' && <ExtensionsSettings />}
      </SettingsPageBody>
    </div>
  )
}
