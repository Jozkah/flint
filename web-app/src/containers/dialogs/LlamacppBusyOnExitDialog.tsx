import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { forceStopEngine } from '@janhq/tauri-plugin-llamacpp-api'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

import { useAppState } from '@/hooks/useAppState'
import { isPlatformTauri } from '@/lib/platform/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'

export default function LlamacppBusyOnExitDialog() {
  const { t } = useTranslation()
  const [busyModels, setBusyModels] = useState<string[] | null>(null)
  const [forcing, setForcing] = useState(false)

  useEffect(() => {
    if (!isPlatformTauri()) return
    const CLOSING_TOAST_ID = 'llamacpp-closing'
    const unlistenAttempt = listen('llamacpp-close-attempt', () => {
      toast.loading(t('common:llamacppBusyOnExit.shuttingDown'), {
        id: CLOSING_TOAST_ID,
        duration: Infinity,
      })
    }).catch((e) => {
      console.warn('listen llamacpp-close-attempt failed:', e)
      return () => {}
    })
    const unlistenBusy = listen<string[]>('llamacpp-busy-on-exit', (event) => {
      toast.dismiss(CLOSING_TOAST_ID)
      setBusyModels(event.payload ?? [])
    }).catch((e) => {
      console.warn('listen llamacpp-busy-on-exit failed:', e)
      return () => {}
    })
    return () => {
      void unlistenAttempt.then((fn) => fn?.())
      void unlistenBusy.then((fn) => fn?.())
      toast.dismiss(CLOSING_TOAST_ID)
    }
  }, [t])

  const handleForceQuit = async () => {
    setForcing(true)
    try {
      const state = useAppState.getState()
      Object.values(state.abortControllers).forEach((ctrl) => {
        try {
          ctrl.abort()
        } catch (e) {
          console.warn('abort controller threw on force-quit:', e)
        }
      })
      const threadIds = new Set<string>([
        ...Object.keys(state.busyThreads),
        ...Object.keys(state.streamingContents),
        ...Object.keys(state.loadingModels),
        ...Object.keys(state.abortControllers),
      ])
      threadIds.forEach((tid) => state.clearThreadState(tid))
      await forceStopEngine()
      await invoke('confirm_exit')
    } catch (e) {
      console.error('force-quit failed:', e)
      setForcing(false)
    }
  }

  const handleCancel = () => {
    setBusyModels(null)
    toast.dismiss('llamacpp-closing')
  }

  return (
    <Dialog open={busyModels !== null} onOpenChange={(o) => !o && handleCancel()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <div className="flex items-start gap-3 text-left">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-warning-tint text-warning">
              <AlertTriangle className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle>{t('common:llamacppBusyOnExit.title')}</DialogTitle>
              <DialogDescription className="mt-1 text-ink-2">
                {t('common:llamacppBusyOnExit.description')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {busyModels && busyModels.length > 0 && (
          <div className="max-h-[150px] min-w-0 overflow-y-auto rounded-md border border-border bg-sunken p-3">
            <ul className="space-y-1 break-all font-mono text-xs text-ink-2">
              {busyModels.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={forcing}
            className="pointer-coarse:h-11"
          >
            {t('common:cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleForceQuit()}
            disabled={forcing}
            autoFocus
            className="pointer-coarse:h-11"
          >
            {forcing
              ? t('common:llamacppBusyOnExit.forcing')
              : t('common:llamacppBusyOnExit.forceQuit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
