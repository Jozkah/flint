import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { useHuggingFaceDownloads } from '@/hooks/useHuggingFaceDownloads'
import { formatModelBytes } from '@/lib/huggingface'
import { installVoiceModel } from '@/lib/voice/installVoiceModel'
import { VOICE_BUNDLE_ID, VOICE_TOTAL_BYTES } from '@/lib/voice/voiceModel'

/** What dictation holds in memory while loaded (the dialog's promise to the user). */
const VOICE_MEMORY_BYTES = 3.5 * 1024 ** 3

/**
 * The one-time setup for dictation: the speech model is not part of Flint, so
 * the first press of the microphone offers to download it, says what that costs,
 * and shows the download.
 */
export function VoiceSetupDialog({
  open,
  onOpenChange,
  onReady,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The model finished installing; dictation can start. */
  onReady?: () => void
}) {
  const { t } = useTranslation()
  const task = useHuggingFaceDownloads((s) => s.tasks[VOICE_BUNDLE_ID])
  const [starting, setStarting] = useState(false)
  const running =
    starting ||
    (!!task && ['queued', 'downloading', 'verifying', 'importing'].includes(task.status))
  const percent = Math.round((task?.progress ?? 0) * 100)

  const start = async () => {
    setStarting(true)
    try {
      await installVoiceModel()
      onReady?.()
      onOpenChange(false)
    } catch (error) {
      toast.error(t('sweep:voice.setupFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('sweep:voice.setup.title')}</DialogTitle>
          <DialogDescription>
            {t('sweep:voice.setup.description', {
              size: formatModelBytes(VOICE_TOTAL_BYTES),
            })}
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            {t('sweep:voice.setup.memory', {
              memory: formatModelBytes(VOICE_MEMORY_BYTES),
            })}
          </li>
          <li>{t('sweep:voice.setup.unloads')}</li>
          <li>{t('sweep:voice.setup.firstPhrase')}</li>
        </ul>
        {running && (
          <div className="space-y-1">
            <Progress value={(task?.progress ?? 0) * 100} className="h-1.5" />
            <p className="text-xs text-muted-foreground">
              {task?.status === 'importing'
                ? t('sweep:voice.setup.installing')
                : task?.status === 'verifying'
                  ? t('sweep:voice.setup.verifying')
                  : t('sweep:voice.setup.downloadingPercent', { percent })}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {running ? t('sweep:voice.setup.close') : t('sweep:voice.setup.notNow')}
          </Button>
          <Button onClick={() => void start()} disabled={running}>
            {running
              ? t('sweep:voice.setup.downloading')
              : t('sweep:voice.setup.download', {
                  size: formatModelBytes(VOICE_TOTAL_BYTES),
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
