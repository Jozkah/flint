import { useEffect, useState } from 'react'
import { LoaderCircle, Mic, Square } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  cancelDictation,
  startDictation,
  stopDictation,
  useVoiceInput,
  voiceInputSupported,
  type ComposerIo,
} from '@/hooks/useVoiceInput'
import { VoiceSetupDialog } from '@/containers/VoiceSetupDialog'
import { VOICE_MODEL_ID } from '@/lib/voice/voiceModel'

/**
 * The microphone beside Send. Press to dictate, press again to stop and keep
 * the text; Escape while listening throws the dictation away.
 */
export function VoiceInputButton({
  composer,
  disabled,
}: {
  composer: ComposerIo
  disabled?: boolean
}) {
  const status = useVoiceInput((s) => s.status)
  const pending = useVoiceInput((s) => s.pending)
  const error = useVoiceInput((s) => s.error)
  const needsSetup = useVoiceInput((s) => s.needsSetup)
  const installed = useModelProvider((s) =>
    s.providers
      .find((p) => p.provider === 'llamacpp')
      ?.models.some((m) => m.id === VOICE_MODEL_ID)
  )
  const [setupOpen, setSetupOpen] = useState(false)

  // The model went missing mid-dictation: offer the setup again.
  useEffect(() => {
    if (needsSetup) {
      setSetupOpen(true)
      useVoiceInput.getState().clearSetup()
    }
  }, [needsSetup])

  useEffect(() => {
    if (!error || error.kind === 'model-missing') return
    toast.error(
      error.kind === 'recorder' ? 'Microphone' : 'Voice input stopped',
      { description: error.message }
    )
    useVoiceInput.getState().clearError()
  }, [error])

  // Escape cancels a dictation in progress.
  useEffect(() => {
    if (status !== 'listening') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void cancelDictation()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status])

  // Leaving the screen ends the dictation: the microphone must not stay open.
  useEffect(() => () => void cancelDictation(), [])

  if (!voiceInputSupported()) return null

  const busy = status === 'starting' || status === 'stopping'
  const listening = status === 'listening'

  const press = () => {
    if (listening) return void stopDictation()
    if (busy) return
    if (!installed) return setSetupOpen(true)
    void startDictation(composer)
  }

  const label = listening
    ? 'Stop dictating'
    : busy
      ? 'Working…'
      : installed
        ? 'Dictate'
        : 'Set up voice input'

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={listening ? 'default' : 'ghost'}
            size="icon-sm"
            disabled={disabled || busy}
            aria-label={label}
            aria-pressed={listening}
            data-test-id="voice-input-button"
            onClick={press}
            className={cn(
              'size-7 pointer-coarse:size-11',
              listening && 'bg-destructive text-white hover:bg-destructive/90'
            )}
          >
            {busy || (listening && pending > 0) ? (
              <LoaderCircle className="size-4 motion-safe:animate-spin" />
            ) : listening ? (
              <Square className="size-3 fill-current" />
            ) : (
              <Mic className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
      <VoiceSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onReady={() => toast.success('Voice input is ready. Press the microphone to dictate.')}
      />
    </>
  )
}
