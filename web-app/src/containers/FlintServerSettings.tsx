import { useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import {
  clearServerConfig,
  loadServerConfig,
  normalizeServerUrl,
  probeServer,
  saveServerConfig,
  type ServerProbe,
} from '@/lib/flintServer'

/**
 * "Flint server": point this build at a `flint serve` instance. Shown only in
 * the Android and iOS builds, which have no agent of their own. Opening the
 * server loads its web app; the sign-in is that page's, so this card holds an
 * address and nothing secret.
 */
export function FlintServerSettings() {
  const { t } = useTranslation()
  const saved = loadServerConfig()
  const [address, setAddress] = useState(saved?.url ?? '')
  const [autoConnect, setAutoConnect] = useState(saved?.autoConnect ?? false)
  const [probe, setProbe] = useState<ServerProbe | 'checking' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const check = normalizeServerUrl(address)

  const explain = (reason: string) => t(`server:problem.${reason}`)

  const test = async () => {
    if (!check.ok) {
      setProblem(explain(check.reason))
      return
    }
    setProblem(null)
    setProbe('checking')
    setProbe(await probeServer(check.url))
  }

  const save = (nextAuto = autoConnect) => {
    if (!check.ok) return
    saveServerConfig({ url: check.url, autoConnect: nextAuto })
  }

  const open = () => {
    if (!check.ok) {
      setProblem(explain(check.reason))
      return
    }
    save()
    window.location.assign(check.url)
  }

  const forget = () => {
    clearServerConfig()
    setAddress('')
    setAutoConnect(false)
    setProbe(null)
    setProblem(null)
  }

  const status =
    probe === 'checking'
      ? t('server:checking')
      : probe?.state === 'ok'
        ? t('server:statusOk')
        : probe?.state === 'reachable'
          ? t('server:statusReachable')
          : probe?.state === 'unreachable'
            ? t('server:statusUnreachable')
            : null

  return (
    <Card
      title={t('server:title')}
      description={t('server:desc')}
    >
      <CardItem
        title={t('server:address')}
        description={t('server:addressDesc')}
        column
        actions={
          <div className="flex w-full flex-col gap-2">
            <Input
              value={address}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://flint.example.ts.net"
              data-testid="flint-server-address"
              onChange={(e) => {
                setAddress(e.target.value)
                setProbe(null)
                setProblem(null)
              }}
            />
            {check.ok && check.insecure && (
              <p className="text-xs text-destructive" role="alert">
                {t('server:insecure')}
              </p>
            )}
            {problem && (
              <p className="text-xs text-destructive" role="alert">
                {problem}
              </p>
            )}
            {status && (
              <p
                className="text-xs text-muted-foreground"
                role="status"
                data-testid="flint-server-status"
              >
                {status}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={test}
                disabled={probe === 'checking'}
              >
                {t('server:test')}
              </Button>
              <Button onClick={open} data-testid="flint-server-open">
                {t('server:open')}
              </Button>
              {saved && (
                <Button variant="ghost" onClick={forget}>
                  {t('server:forget')}
                </Button>
              )}
            </div>
          </div>
        }
      />
      <CardItem
        title={t('server:auto')}
        description={t('server:autoDesc')}
        actions={
          <Switch
            checked={autoConnect}
            disabled={!check.ok}
            onCheckedChange={(value) => {
              setAutoConnect(value)
              save(value)
            }}
          />
        }
      />
      <CardItem
        title={t('server:limitsTitle')}
        description={t('server:limits')}
      />
    </Card>
  )
}
