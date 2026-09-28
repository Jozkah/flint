import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useRemoteAccess } from '@/hooks/useRemoteAccess'
import { remoteApi, type RemoteApi } from '@/lib/remote/api'

/**
 * Asks the user to confirm a phone that used the pairing code, showing the
 * number both screens derive from it. Nothing is issued to the phone until
 * Pair is clicked here. Mounted once in the app shell.
 */
export function RemotePairingConfirm({ api = remoteApi }: { api?: RemoteApi }) {
  const { t } = useTranslation()
  const request = useRemoteAccess((s) => s.pairingRequest)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!request) return null

  const answer = async (approve: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const device = await api.confirmPairing(request.requestId, approve)
      const store = useRemoteAccess.getState()
      store.setPairingRequest(null)
      if (device) store.setLastPaired(device)
    } catch {
      setError(t('remote:confirmExpired'))
    } finally {
      setBusy(false)
    }
  }

  const dismiss = () => {
    // Closing without an answer refuses: silence must never pair.
    void api.confirmPairing(request.requestId, false).catch(() => {})
    useRemoteAccess.getState().setPairingRequest(null)
    setError(null)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent data-testid="remote-confirm-dialog">
        <DialogHeader>
          <DialogTitle>{t('remote:confirmTitle', { name: request.deviceName })}</DialogTitle>
          <DialogDescription>{t('remote:confirmDesc')}</DialogDescription>
        </DialogHeader>
        <p
          data-testid="remote-confirm-number"
          className="text-center font-mono text-3xl tracking-[0.2em] tabular-nums"
        >
          {request.confirmNumber.slice(0, 3)} {request.confirmNumber.slice(3)}
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void answer(false)}>
            {t('remote:deny')}
          </Button>
          <Button disabled={busy} data-testid="remote-confirm" onClick={() => void answer(true)}>
            {t('remote:confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
