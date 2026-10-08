import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { VoicePill, type VoicePillEnd } from '@/components/ui/voice-pill'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  cancelDictation,
  startDictation,
  stopDictation,
  useVoiceInput,
  voiceInputSupported,
  voiceLevel,
  type ComposerIo,
} from '@/hooks/useVoiceInput'
import { VoiceSetupDialog } from '@/containers/VoiceSetupDialog'
import { VOICE_MODEL_ID } from '@/lib/voice/voiceModel'

/**
 * The microphone beside Send. Tap to dictate, tap again to stop and keep the
 * text, or hold to record while held and drag left to cancel. Escape while
 * listening throws the dictation away.
 */
export function VoiceInputButton({
  composer,
  disabled,
}: {
  composer: ComposerIo
  disabled?: boolean
}) {
  const { t } = useTranslation()
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

  const begin = () => {
    if (busy || listening) return
    if (!installed) return setSetupOpen(true)
    void startDictation(composer)
  }

  const end = (reason: VoicePillEnd) => {
    if (reason === 'cancel') void cancelDictation()
    else void stopDictation()
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
          <VoicePill
            listening={listening}
            busy={busy}
            spinning={pending > 0}
            disabled={disabled}
            cancelLabel={t('common:voicePill.cancel')}
            aria-label={label}
            aria-pressed={listening}
            data-test-id="voice-input-button"
            onBegin={begin}
            onEnd={end}
            getLevel={voiceLevel}
            className="size-7 pointer-coarse:size-11"
          />
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
