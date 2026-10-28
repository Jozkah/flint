import { isServedByFlint } from '@/lib/platform/utils'
import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { FolderAccessCard } from '@/containers/FolderAccessCard'
import { TrustedFoldersCard } from '@/containers/TrustedFoldersCard'
import { HooksViewerCard } from '@/containers/HooksViewerCard'
import { ApprovalRulesCard } from '@/containers/ApprovalRulesCard'
import { PolicyRuleWarningsCard } from '@/containers/PolicyRuleWarningsCard'
import { BrowserSitePermissions } from '@/containers/BrowserAgentSettings'
import { ChatMentionSettings } from '@/containers/ChatMentionSettings'
import { SettingsTabStrip, useSettingsTab, type SettingsTab } from '@/containers/SettingsTabs'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SettingsPageBody, SettingsPageHeader } from '@/containers/SettingsPageHeader'
import { useMcpTrustReport } from '@/hooks/useMcpTrustReport'
import { useAuditHistory } from '@/hooks/useAuditHistory'
import { AutoApproveSection } from '@/containers/permissions/AutoApproveSection'
import { McpAllowAllSection } from '@/containers/permissions/McpAllowAllSection'
import { TrustedServersSection } from '@/containers/permissions/TrustedServersSection'
import { StaleApprovalsSection } from '@/containers/permissions/StaleApprovalsSection'
import { ConversationGrantsSection } from '@/containers/permissions/ConversationGrantsSection'
import { GlobalGrantsSection } from '@/containers/permissions/GlobalGrantsSection'
import { AuditLogSection } from '@/containers/permissions/AuditLogSection'

export const Route = createFileRoute(route.settings.permissions)({
  component: PermissionsSettings,
})

type PermissionsTab = 'rules' | 'access' | 'remembered' | 'activity'

function PermissionsSettings() {
  const { t } = useTranslation()
  const trust = useMcpTrustReport()
  const audit = useAuditHistory()

  // A search result opens the tab that holds the setting it names.
  const tabs: SettingsTab<PermissionsTab>[] = [
    {
      id: 'rules',
      label: t('permissions:settings.tabRules', { defaultValue: 'Rules' }),
      anchors: [
        'settings-permissions-mode',
        'settings-permissions-auto-approve-limit*',
        'settings-permissions-allow-permissions',
        'settings-permissions-renewal',
        'settings-permissions-chat-mentions',
      ],
    },
    {
      id: 'access',
      label: t('permissions:settings.tabAccess', { defaultValue: 'Access' }),
      anchors: [
        'settings-permissions-folder-access',
        'settings-permissions-trusted-folders',
        'settings-permissions-browser-*',
      ],
    },
    {
      id: 'remembered',
      label: t('permissions:settings.tabRemembered', { defaultValue: 'Remembered' }),
      anchors: [
        'settings-permissions-conversations',
        'settings-permissions-everywhere',
        'settings-permissions-approval-rules',
      ],
    },
    {
      id: 'activity',
      label: t('permissions:settings.tabActivity', { defaultValue: 'Activity' }),
      anchors: [
        'settings-permissions-deferred-approvals',
        'settings-permissions-history',
      ],
    },
  ]
  const [tab, setTab] = useSettingsTab(tabs)

  return (
    <div className="flex flex-col h-full">
      <SettingsPageHeader title={t('permissions:settings.title')} />
      <SettingsPageBody
        title={t('permissions:settings.title')}
        description={
          <>
            <span>{t('permissions:settings.intro')}</span>{' '}
            <span>{t('permissions:settings.revokeEffect')}</span>
          </>
        }
        actions={
          <SettingsTabStrip<PermissionsTab>
            label={t('permissions:settings.title')}
            tabs={tabs}
            value={tab}
            onChange={setTab}
          />
        }
      >
        {tab === 'rules' && <PolicyRuleWarningsCard />}
        {tab === 'rules' && <AutoApproveSection />}
        {tab === 'rules' && <McpAllowAllSection />}
        {tab === 'rules' && (
          <TrustedServersSection
            servers={trust.servers}
            report={trust.report}
            serversError={trust.serversError}
            serverErrors={trust.serverErrors}
            busyServer={trust.busyServer}
            onRevokeServer={trust.onRevokeServer}
          />
        )}
        {tab === 'rules' && trust.pendingRenewals.length > 0 && (
          <StaleApprovalsSection
            pendingRenewals={trust.pendingRenewals}
            servers={trust.servers}
            serverErrors={trust.serverErrors}
            busyServer={trust.busyServer}
            onRevokeServer={trust.onRevokeServer}
          />
        )}

        {/* Desktop only: the setting is the desktop app's. */}
        {tab === 'rules' && !isServedByFlint() && <ChatMentionSettings />}
        {/* Folders granted through request_access */}
        {tab === 'access' && (
          <FolderAccessCard />
        )}
        {tab === 'access' && (
          <TrustedFoldersCard />
        )}
        {tab === 'access' && <HooksViewerCard />}

        {/* The browser pane is the desktop app's. */}
        {tab === 'access' && !isServedByFlint() && <BrowserSitePermissions />}
        {tab === 'remembered' && <ConversationGrantsSection />}
        {tab === 'remembered' && <GlobalGrantsSection />}

        {tab === 'remembered' && (
          <ApprovalRulesCard show="rules" />
        )}
        {tab === 'activity' && (
          <ApprovalRulesCard show="waiting" />
        )}
        {tab === 'activity' && <AuditLogSection {...audit} />}
      </SettingsPageBody>
    </div>
  )
}
