import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with whether the original chat should be deleted afterwards. */
  onChoose: (deleteChat: boolean) => void | Promise<void>
}

/** Asks what becomes of the chat once it has been converted to a Cowork session. */
export function ConvertToCoworkDialog({ open, onOpenChange, onChoose }: Props) {
  const { t } = useTranslation()
  const choose = (deleteChat: boolean) => {
    onOpenChange(false)
    void onChoose(deleteChat)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('chat:convertToCowork.title')}</DialogTitle>
          <DialogDescription>
            {t('chat:convertToCowork.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="convert-delete-chat"
            onClick={() => choose(true)}
          >
            {t('chat:convertToCowork.delete')}
          </Button>
          <Button data-testid="convert-keep-chat" onClick={() => choose(false)}>
            {t('chat:convertToCowork.keep')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
