import { useRef, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { FactoryResetOptions } from '@/services/app/types'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'

interface FactoryResetDialogProps {
  onReset: (options: FactoryResetOptions) => void
  children: React.ReactNode
}

export function FactoryResetDialog({
  onReset,
  children,
}: FactoryResetDialogProps) {
  const { t } = useTranslation()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const resetting = useRef(false)
  const [keepAppData, setKeepAppData] = useState(true)
  const [keepModelsAndConfigs, setKeepModelsAndConfigs] = useState(true)
  const [clearWebData, setClearWebData] = useState(false)

  // One reset per confirmation: a key press can also fire the click.
  const handleReset = () => {
    if (resetting.current) return
    resetting.current = true
    onReset({ keepAppData, keepModelsAndConfigs, clearWebData })
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) resetting.current = false
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="sm:max-w-[440px] lg:max-w-[440px] xl:max-w-[440px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // Focus starts on Cancel, so a reflexive Enter resets nothing.
          cancelButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('settings:general.factoryResetTitle')}</DialogTitle>
          <DialogDescription>
            {t('settings:general.factoryResetDesc')}
          </DialogDescription>
        </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md py-1 sm:min-h-0">
              <input
                type="checkbox"
                checked={keepAppData}
                onChange={(e) => setKeepAppData(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border accent-primary cursor-pointer"
              />
              <div className="flex flex-col">
                <span className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                  {t('settings:general.keepAppData')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('settings:general.keepAppDataDesc')}
                </span>
              </div>
            </label>
            <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md py-1 sm:min-h-0">
              <input
                type="checkbox"
                checked={keepModelsAndConfigs}
                onChange={(e) => setKeepModelsAndConfigs(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border accent-primary cursor-pointer"
              />
              <div className="flex flex-col">
                <span className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                  {t('settings:general.keepModelsAndConfigs')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('settings:general.keepModelsAndConfigsDesc')}
                </span>
              </div>
            </label>
            <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md py-1 sm:min-h-0">
              <input
                type="checkbox"
                checked={clearWebData}
                onChange={(e) => setClearWebData(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border accent-primary cursor-pointer"
              />
              <div className="flex flex-col">
                <span className="text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                  {t('settings:general.clearWebData')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('settings:general.clearWebDataDesc')}
                </span>
              </div>
            </label>
          </div>
          <DialogFooter className={STICKY_DIALOG_FOOTER}>
            <DialogClose asChild>
              <Button
                ref={cancelButtonRef}
                variant="surface"
                className="w-full sm:w-auto pointer-coarse:h-11"
              >
                {t('settings:general.cancel')}
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button
                variant="destructive"
                onClick={handleReset}
                className="w-full sm:w-auto pointer-coarse:h-11"
                aria-label={t('settings:general.reset')}
              >
                {t('settings:general.reset')}
              </Button>
            </DialogClose>
          </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
