import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { SettingsPageBody, SettingsPageHeader } from '@/containers/SettingsPageHeader'
import { RemoteAccessSettings } from '@/containers/RemoteAccessSettings'
import { useTranslation } from '@/i18n/react-i18next-compat'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.remote_access as any)({
  component: RemoteAccess,
})

/** Remote access: use Flint on this computer from a paired phone. */
function RemoteAccess() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={t('remote:title')} />
      <SettingsPageBody title={t('remote:title')} description={t('remote:pageDesc')}>
        <RemoteAccessSettings
          anchors={{
            enable: 'settings-remote-access-enable',
            interface: 'settings-remote-access-interface',
            approvals: 'settings-remote-access-approvals',
            devices: 'settings-remote-access-devices',
          }}
        />
      </SettingsPageBody>
    </div>
  )
}
