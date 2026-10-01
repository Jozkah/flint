import { useState } from 'react'
import { toast } from 'sonner'
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
      toast.error('Could not set up voice input', {
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
          <DialogTitle>Set up voice input</DialogTitle>
          <DialogDescription>
            Dictation turns your speech into text on this computer, with a speech
            model that Flint downloads once ({formatModelBytes(VOICE_TOTAL_BYTES)}).
            Nothing you say leaves your device.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>It runs next to your chat model and needs about 3.5 GB of free memory while you dictate.</li>
          <li>It unloads a few minutes after you stop, to give the memory back.</li>
          <li>The first phrase after loading takes a few seconds.</li>
        </ul>
        {running && (
          <div className="space-y-1">
            <Progress value={(task?.progress ?? 0) * 100} className="h-1.5" />
            <p className="text-xs text-muted-foreground">
              {task?.status === 'importing'
                ? 'Installing…'
                : task?.status === 'verifying'
                  ? 'Verifying…'
                  : `Downloading… ${percent}%`}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {running ? 'Close' : 'Not now'}
          </Button>
          <Button onClick={() => void start()} disabled={running}>
            {running ? 'Downloading…' : `Download (${formatModelBytes(VOICE_TOTAL_BYTES)})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
