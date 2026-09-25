import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Input } from '@/components/ui/input'
import { EyeOff, Eye } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useProxyConfig } from '@/hooks/useProxyConfig'
import { CaBundleStatus, type CaBundleState } from '@/containers/CaBundleStatus'
import { getServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.https_proxy as any)({
  component: HTTPSProxyContent,
})

function HTTPSProxyContent() {
  const { t } = useTranslation()
  const [showPassword, setShowPassword] = useState(false)
  const {
    proxyUrl,
    proxyEnabled,
    proxyUsername,
    proxyPassword,
    proxyIgnoreSSL,
    noProxy,
    setProxyEnabled,
    setProxyUsername,
    setProxyPassword,
    setProxyIgnoreSSL,
    setNoProxy,
    setProxyUrl,
    caBundlePath,
    setCaBundlePath,
  } = useProxyConfig()
  const [caStatus, setCaStatus] = useState<CaBundleState | null>(null)

  // AH-190: what the bundle would do, checked by the backend as it is typed.
  useEffect(() => {
    if (!isPlatformTauri()) return
    let cancelled = false
    const timer = setTimeout(() => {
      getServiceHub()
        .core()
        .invoke<CaBundleState>('network_ca_check', { path: caBundlePath })
        .then((status) => {
          if (!cancelled) setCaStatus(status)
        })
        .catch(() => {
          if (!cancelled) setCaStatus(null)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [caBundlePath])

  const toggleProxy = useCallback(
    (checked: boolean) => {
      setProxyEnabled(checked)
    },
    [setProxyEnabled]
  )

  return (
    <div className="flex flex-col h-full w-full">
      <SettingsPageHeader title={t('common:https_proxy')} />
      <SettingsPageBody
        title={t('common:https_proxy')}
        description={t('settings:pageDesc.httpsProxy')}
      >
        {/* Proxy Configuration */}
        <Card
          title={t('settings:httpsProxy.proxy')}
          aside={
            <Switch
              aria-label={t('settings:httpsProxy.proxy')}
              checked={proxyEnabled}
              onCheckedChange={toggleProxy}
            />
          }
        >
          <CardItem
            anchor="settings-https-proxy-proxy-url"
            title={t('settings:httpsProxy.proxyUrl')}
            className="block"
            description={
              <div className="space-y-2">
                <p>{t('settings:httpsProxy.proxyUrlDesc')}</p>
                <Input
                  className="w-full font-mono"
                  placeholder={t(
                    'settings:httpsProxy.proxyUrlPlaceholder'
                  )}
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                />
              </div>
            }
          />
          <CardItem
            title={t('settings:httpsProxy.authentication')}
            className="block"
            description={
              <div className="space-y-2">
                <p>{t('settings:httpsProxy.authenticationDesc')}</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    placeholder={t('settings:httpsProxy.username')}
                    value={proxyUsername}
                    onChange={(e) => setProxyUsername(e.target.value)}
                  />
                  <div className="relative w-full shrink-0 sm:w-1/2">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      placeholder={t('settings:httpsProxy.password')}
                      className="pr-12"
                      value={proxyPassword}
                      onChange={(e) => setProxyPassword(e.target.value)}
                    />
                    <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
                      <button
                        type="button"
                        aria-label={
                          showPassword
                            ? t('settings:httpsProxy.hidePassword')
                            : t('settings:httpsProxy.showPassword')
                        }
                        aria-pressed={showPassword}
                        onClick={() => setShowPassword(!showPassword)}
                        className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover-row hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-10"
                      >
                        {showPassword ? (
                          <EyeOff size={16} />
                        ) : (
                          <Eye size={16} />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            }
          />
          <CardItem
            anchor="settings-https-proxy-no-proxy"
            title={t('settings:httpsProxy.noProxy')}
            className="block"
            description={
              <div className="space-y-2">
                <p>{t('settings:httpsProxy.noProxyDesc')}</p>
                <Input
                  className="font-mono"
                  placeholder={t(
                    'settings:httpsProxy.noProxyPlaceholder'
                  )}
                  value={noProxy}
                  onChange={(e) => setNoProxy(e.target.value)}
                />
              </div>
            }
          />
          <CardItem
            anchor="settings-https-proxy-ignore-ssl"
            title={t('settings:httpsProxy.ignoreSsl')}
            description={t('settings:httpsProxy.ignoreSslDesc')}
            actions={
              <Switch
                checked={proxyIgnoreSSL}
                onCheckedChange={(checked) => setProxyIgnoreSSL(checked)}
              />
            }
          />
        </Card>
        <Card title={t('settings:httpsProxy.caBundle')}>
          <CardItem
            anchor="settings-https-proxy-ca-bundle"
            title={t('settings:httpsProxy.caBundlePath')}
            className="block"
            description={
              <div className="space-y-2">
                <p>{t('settings:httpsProxy.caBundleDesc')}</p>
                <Input
                  className="w-full font-mono"
                  data-testid="ca-bundle-path"
                  placeholder={t('settings:httpsProxy.caBundlePlaceholder')}
                  value={caBundlePath}
                  onChange={(e) => setCaBundlePath(e.target.value)}
                />
                <CaBundleStatus status={caStatus} />
              </div>
            }
          />
        </Card>
      </SettingsPageBody>
    </div>
  )
}
