import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type {
  MemoryScope,
  MemoryView,
} from '@janhq/tauri-plugin-agent-tools-api'

type EditProps = {
  editing: MemoryView | null
  draft: string
  busy: boolean
  onDraftChange: (draft: string) => void
  onClose: () => void
  onSave: () => void | Promise<void>
}

export function MemoryEditDialog({
  editing,
  draft,
  busy,
  onDraftChange,
  onClose,
  onSave,
}: EditProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings:memoryPage.editTitle')}</DialogTitle>
          <DialogDescription>{t('settings:memoryPage.editBody')}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={draft}
          aria-label={t('settings:memoryPage.contentAria')}
          rows={6}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <Button variant="ghost" className="pointer-coarse:h-11" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            disabled={busy || !draft.trim()}
            data-testid="memory-edit-save"
            onClick={() => void onSave()}
          >
            {t('common:save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type ClearProps = {
  clearing: MemoryScope | null
  busy: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
}

export function MemoryClearDialog({
  clearing,
  busy,
  onClose,
  onConfirm,
}: ClearProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={clearing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="memory-clear-dialog">
        <DialogHeader>
          <DialogTitle>{t('settings:memoryPage.clearTitle')}</DialogTitle>
          <DialogDescription>
            {clearing ? t(`settings:memoryPage.scope.${clearing}.clearBody`) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <Button variant="ghost" className="pointer-coarse:h-11" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            data-testid="memory-clear-confirm"
            onClick={() => void onConfirm()}
          >
            {t('settings:memoryPage.clearConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
