import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Card, CardItem } from '@/containers/Card'
import { QrCode } from '@/containers/QrCode'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useRemoteAccess } from '@/hooks/useRemoteAccess'
import {
  remoteApi,
  type RemoteApi,
  type RemoteConfig,
  type RemoteInterface,
  type RemotePairing,
  type RemoteStatus,
} from '@/lib/remote/api'
import { countdown } from '@/lib/remote/format'

export type RemoteAccessAnchors = {
  enable: string
  interface: string
  approvals: string
  devices: string
}

const IFACES: RemoteInterface[] = ['tailscale', 'lan', 'localhost']

function detectedFor(status: RemoteStatus, iface: RemoteInterface): string | null {
  if (iface === 'localhost') return '127.0.0.1'
  return iface === 'tailscale' ? status.detected.tailscale : status.detected.lan
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * Settings › Remote access: the switch, where Flint listens, what phones may
 * approve, and the paired phones. The backend owns every setting and
 * enforces the approval switches itself; this page only edits them.
 */
export function RemoteAccessSettings({
  api = remoteApi,
  anchors,
}: {
  api?: RemoteApi
  anchors?: RemoteAccessAnchors
}) {
  const { t } = useTranslation()
  const status = useRemoteAccess((s) => s.status)
  const devices = useRemoteAccess((s) => s.devices)
  const [portInput, setPortInput] = useState('')
  const [hostInput, setHostInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pairOpen, setPairOpen] = useState(false)

  const refresh = useCallback(async () => {
    const [s, d] = await Promise.all([api.getStatus(), api.listDevices()])
    useRemoteAccess.setState({ status: s, devices: d })
    setPortInput(String(s.config.port))
    setHostInput(s.config.customHost ?? '')
  }, [api])

  useEffect(() => {
    void refresh().catch((e) => setError(String(e)))
  }, [refresh])

  const save = async (patch: Partial<RemoteConfig>) => {
    if (!status) return
    setError(null)
    try {
      const next = await api.setConfig({ ...status.config, ...patch })
      useRemoteAccess.setState({ status: next })
      setPortInput(String(next.config.port))
      setHostInput(next.config.customHost ?? '')
    } catch (e) {
      setError(String(e))
    }
  }

  const revoke = async (id: string) => {
    await api.revokeDevice(id).catch((e) => setError(String(e)))
    await refresh().catch(() => {})
  }

  if (!status) {
    return error ? <p className="px-4 text-xs text-destructive">{error}</p> : null
  }
  const cfg = status.config
  const serving = status.serving
  const detected = detectedFor(status, cfg.interface)

  const connectionText = !serving
    ? t('remote:notRunning')
    : serving.https
      ? t('remote:httpsOn', { source: t(`remote:tlsSource.${serving.tlsSource}`) })
      : cfg.interface === 'tailscale'
        ? t('remote:httpOverTailscale')
        : t('remote:httpLocal')

  return (
    <>
      <Card title={t('remote:cardAccess')}>
        <CardItem
          anchor={anchors?.enable}
          title={t('remote:enable')}
          description={t('remote:enableDesc')}
          actions={
            <Switch
              data-testid="remote-enable"
              aria-label={t('remote:enable')}
              checked={cfg.enabled}
              onCheckedChange={(enabled) => void save({ enabled })}
            />
          }
        />
        <CardItem
          anchor={anchors?.interface}
          column
          title={t('remote:reachable')}
          description={
            <span data-testid="remote-detected">
              {t('remote:reachableDesc')}{' '}
              {detected ?? t('remote:notDetected')}
            </span>
          }
          actions={
            <Segmented
              aria-label={t('remote:reachable')}
              size="sm"
              value={cfg.interface}
              onValueChange={(iface) => void save({ interface: iface })}
              options={IFACES.map((value) => ({
                value,
                label: t(`remote:iface.${value}`),
                testId: `remote-iface-${value}`,
              }))}
            />
          }
        />
        <CardItem
          title={t('remote:port')}
          description={t('remote:portDesc')}
          actions={
            <input
              type="number"
              min={1024}
              max={65535}
              data-testid="remote-port"
              aria-label={t('remote:port')}
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              onBlur={() => {
                const port = Number(portInput)
                if (Number.isInteger(port) && port !== cfg.port) void save({ port })
                else setPortInput(String(cfg.port))
              }}
              className="h-8 w-24 rounded border border-border bg-card px-2 text-xs"
            />
          }
        />
        <CardItem
          title={t('remote:customHost')}
          description={t('remote:customHostDesc')}
          actions={
            <input
              type="text"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              data-testid="remote-custom-host"
              aria-label={t('remote:customHost')}
              placeholder={serving?.host ?? detected ?? ''}
              value={hostInput}
              onChange={(e) => setHostInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={() => {
                const customHost = hostInput.trim() || null
                if (customHost !== (cfg.customHost ?? null)) void save({ customHost })
                else setHostInput(cfg.customHost ?? '')
              }}
              className="h-8 w-56 rounded border border-border bg-card px-2 text-xs"
            />
          }
        />
        <CardItem
          title={t('remote:https')}
          description={
            <span data-testid="remote-connection">
              {serving ? `${serving.baseUrl} · ` : ''}
              {connectionText}
            </span>
          }
        />
        {serving?.fingerprint && serving.tlsSource === 'self_signed' && (
          <CardItem
            column
            title={t('remote:fingerprint')}
            description={t('remote:fingerprintDesc')}
            actions={
              <code
                data-testid="remote-fingerprint"
                className="w-full break-all font-mono text-[11px]"
              >
                {serving.fingerprint}
              </code>
            }
          />
        )}
        {status.error && (
          <p className="px-4 pb-2 text-xs text-destructive" data-testid="remote-error">
            {t('remote:startError', { error: status.error })}
          </p>
        )}
        {error && <p className="px-4 pb-2 text-xs text-destructive">{error}</p>}
      </Card>

      <Card title={t('remote:cardApprovals')}>
        <CardItem
          anchor={anchors?.approvals}
          title={t('remote:allowApprovals')}
          description={t('remote:allowApprovalsDesc')}
          actions={
            <Switch
              data-testid="remote-allow-approvals"
              aria-label={t('remote:allowApprovals')}
              checked={cfg.allowApprovals}
              onCheckedChange={(allowApprovals) =>
                void save(
                  // Turning approvals off takes "Always allow" with it.
                  allowApprovals ? { allowApprovals } : { allowApprovals, allowAlwaysAllow: false }
                )
              }
            />
          }
        />
        <CardItem
          title={t('remote:allowAlways')}
          description={t('remote:allowAlwaysDesc')}
          actions={
            <Switch
              data-testid="remote-allow-always"
              aria-label={t('remote:allowAlways')}
              disabled={!cfg.allowApprovals}
              checked={cfg.allowApprovals && cfg.allowAlwaysAllow}
              onCheckedChange={(allowAlwaysAllow) => void save({ allowAlwaysAllow })}
            />
          }
        />
      </Card>

      <Card
        title={t('remote:cardDevices')}
        aside={
          <Button
            size="sm"
            variant="outline"
            data-testid="remote-pair"
            disabled={!status.running}
            onClick={() => setPairOpen(true)}
          >
            {t('remote:pair')}
          </Button>
        }
      >
        <CardItem
          anchor={anchors?.devices}
          align="start"
          description={
            devices.length === 0 ? (
              <span className="text-muted-foreground">{t('remote:noDevices')}</span>
            ) : (
              <ul data-testid="remote-devices" className="flex flex-col gap-2">
                {devices.map((d) => (
                  <li key={d.id} className="flex items-center gap-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium text-foreground">{d.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {d.connected
                          ? t('remote:connected')
                          : [
                              t('remote:pairedOn', { date: formatDate(d.pairedAt) }),
                              d.lastSeen
                                ? t('remote:lastSeen', { date: formatDate(d.lastSeen) })
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`remote-remove-${d.id}`}
                      onClick={() => void revoke(d.id)}
                    >
                      {t('remote:remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          }
        />
      </Card>

      {pairOpen && (
        <PairPhoneDialog
          api={api}
          onClose={() => {
            setPairOpen(false)
            void refresh().catch(() => {})
          }}
        />
      )}
    </>
  )
}

/**
 * The QR code and number for pairing, with a live expiry. The confirmation
 * itself is `RemotePairingConfirm`, mounted app-wide, so a phone that scans
 * while this dialog is closed is still asked about.
 */
export function PairPhoneDialog({
  api = remoteApi,
  onClose,
}: {
  api?: RemoteApi
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [pairing, setPairing] = useState<RemotePairing | null>(null)
  const [deadline, setDeadline] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const lastPaired = useRemoteAccess((s) => s.lastPaired)

  const start = useCallback(async () => {
    setError(null)
    setCopyError(null)
    setCopied(false)
    useRemoteAccess.getState().setLastPaired(null)
    try {
      const p = await api.startPairing()
      setPairing(p)
      setDeadline(Date.now() + p.expiresInMs)
      setNow(Date.now())
    } catch (e) {
      setError(String(e))
    }
  }, [api])

  useEffect(() => {
    void start()
  }, [start])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const expired = pairing !== null && now >= deadline

  const copyPairingLink = async () => {
    if (!pairing || expired) return
    try {
      await navigator.clipboard.writeText(pairing.url)
      setCopyError(null)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
      setCopyError('Could not copy the pairing link. Select the link below and copy it manually.')
    }
  }

  const close = () => {
    if (!lastPaired) void api.cancelPairing().catch(() => {})
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent data-testid="remote-pair-dialog">
        <DialogHeader>
          <DialogTitle>{t('remote:pairTitle')}</DialogTitle>
          <DialogDescription>
            Scan the QR code with your phone, or copy the pairing link and open it there.
          </DialogDescription>
        </DialogHeader>
        {lastPaired ? (
          <p className="text-sm" data-testid="remote-pair-done">
            {t('remote:pairDone', { name: lastPaired.name })}
          </p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : pairing ? (
          <div className="flex flex-col items-center gap-4">
            {expired ? (
              <p className="text-sm text-muted-foreground">{t('remote:pairExpired')}</p>
            ) : (
              <QrCode value={pairing.url} label={t('remote:pairTitle')} />
            )}
            {!expired && (
              <div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium">Pairing link</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="remote-copy-pair-link"
                    onClick={() => void copyPairingLink()}
                  >
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                </div>
                <input
                  readOnly
                  aria-label="Pairing link"
                  value={pairing.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full rounded border border-border bg-card px-2 py-2 font-mono text-[11px]"
                />
                {copyError && (
                  <span className="text-[11px] text-destructive" role="status">
                    {copyError}
                  </span>
                )}
                <span className="text-[11px] text-muted-foreground">
                  Open this exact link on the phone you want to connect. You will still confirm the matching number on this computer.
                </span>
              </div>
            )}
            <div className="flex flex-col items-center">
              <span className="text-xs text-muted-foreground">{t('remote:pairCode')}</span>
              <span
                data-testid="remote-pair-number"
                className="font-mono text-2xl tracking-[0.2em] tabular-nums"
              >
                {pairing.confirmNumber.slice(0, 3)} {pairing.confirmNumber.slice(3)}
              </span>
              {!expired && (
                <span className="text-xs text-muted-foreground" data-testid="remote-pair-expiry">
                  {t('remote:pairExpires', { time: countdown(deadline, now) })}
                </span>
              )}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          {expired && !lastPaired && (
            <Button variant="outline" onClick={() => void start()}>
              {t('remote:pairNew')}
            </Button>
          )}
          <Button onClick={close}>{t('remote:close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
