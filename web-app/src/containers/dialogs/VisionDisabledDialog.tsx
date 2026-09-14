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

/**
 * What to do about an image the selected model cannot read.
 *
 * Silently dropping it was the old answer, and it was the wrong one twice
 * over: the user had already decided the picture mattered, and the model may
 * well be able to see -- Jan only knows a model's capabilities from its
 * metadata, which for a manually added provider or an OpenAI-compatible
 * endpoint is routinely incomplete. So this asks rather than decides.
 */
export type VisionDisabledChoice = 'proceed' | 'enable' | 'cancel'

type VisionDisabledDialogProps = {
  open: boolean
  /** The images the model cannot read, named so the user knows what is at stake. */
  fileNames: readonly string[]
  /** The model in question, by the name the user picked it under. */
  modelName: string
  /**
   * Whether turning vision on could actually work. A local llama.cpp model
   * needs an mmproj file to see anything; without one the switch would only
   * buy a failed request, so the option is withheld and the reason given.
   */
  canEnable: boolean
  onChoose: (choice: VisionDisabledChoice) => void
}

export function VisionDisabledDialog({
  open,
  fileNames,
  modelName,
  canEnable,
  onChoose,
}: VisionDisabledDialogProps) {
  const { t } = useTranslation()
  const count = fileNames.length

  return (
    <Dialog
      open={open}
      // Dismissing (Escape, the close button, a click outside) is a cancel:
      // the draft is left exactly as the user had it.
      onOpenChange={(next) => {
        if (!next) onChoose('cancel')
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('common:attachFiles.visionDisabled.title', { count })}
          </DialogTitle>
          <DialogDescription>
            {t('common:attachFiles.visionDisabled.description', {
              count,
              model: modelName,
            })}
          </DialogDescription>
        </DialogHeader>

        <p
          className="text-sm text-muted-foreground break-words"
          data-testid="vision-disabled-files"
        >
          {fileNames.join(', ')}
        </p>

        {!canEnable && (
          <p className="text-sm text-muted-foreground">
            {t('common:attachFiles.visionDisabled.needsMmproj')}
          </p>
        )}

        <DialogFooter>
          <Button variant="link" onClick={() => onChoose('cancel')}>
            {t('common:cancel')}
          </Button>
          <Button variant="outline" onClick={() => onChoose('proceed')}>
            {t('common:attachFiles.visionDisabled.proceed', { count })}
          </Button>
          {canEnable && (
            <Button onClick={() => onChoose('enable')}>
              {t('common:attachFiles.visionDisabled.enable')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default VisionDisabledDialog
