import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { CLEAR_SCOPES, type ClearScope } from '@/lib/rooms/clearRoom'

/**
 * What to clear, asked before anything is deleted. The choices are cumulative,
 * the room's settings and attached folders are never touched, and it says so.
 */
export function ClearRoomDialog({
  open,
  running,
  onCancel,
  onClear,
}: {
  open: boolean
  /** A running room cannot be cleared; the dialog says to stop it first. */
  running: boolean
  onCancel: () => void
  onClear: (scope: ClearScope) => void
}) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<ClearScope>('chat')
  useEffect(() => {
    if (open) setScope('chat')
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('rooms:clear.title')}</DialogTitle>
          <DialogDescription>
            {running ? t('rooms:clear.running') : t('rooms:clear.description')}
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={scope}
          onValueChange={(v) => setScope(v as ClearScope)}
          disabled={running}
          aria-label={t('rooms:clear.title')}
          className="gap-1.5"
        >
          {CLEAR_SCOPES.map((s) => (
            <label
              key={s}
              htmlFor={`clear-${s}`}
              className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border-[0.8px] border-border p-2.5 transition-colors hover:bg-hover-row has-[[data-state=checked]]:bg-card"
            >
              <RadioGroupItem id={`clear-${s}`} value={s} aria-label={t(`rooms:clear.${s}`)} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <Label htmlFor={`clear-${s}`} className="cursor-pointer">
                  {t(`rooms:clear.${s}`)}
                </Label>
                <span className="text-xs text-muted-foreground">{t(`rooms:clear.${s}Hint`)}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <p className="text-xs text-muted-foreground">{t('rooms:clear.kept')}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t('common:cancel')}
          </Button>
          <Button variant="destructive" disabled={running} onClick={() => onClear(scope)}>
            {t('rooms:clear.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
