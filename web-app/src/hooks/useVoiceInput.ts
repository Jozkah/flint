import { create } from 'zustand'
import { DictationSession, type DictationError } from '@/lib/voice/dictation'
import { createBrowserRecorder, type Recorder } from '@/lib/voice/recorder'
import { transcribeWav, VoiceModelMissingError } from '@/lib/voice/transcribe'
import {
  captureAnchor,
  mergeDictation,
  revertDictation,
  type DictationAnchor,
} from '@/lib/voice/promptMerge'

/**
 * Dictation into the message box.
 *
 * The box belongs to the composer, so this takes three small hooks into it
 * instead of owning it: read the value, read the caret, write a value and caret.
 * Every phrase rewrites the box from the anchor taken when the microphone was
 * pressed, so nothing the user wrote around the caret is disturbed.
 */

export type ComposerIo = {
  getValue: () => string
  getCaret: () => number | null
  apply: (value: string, caret: number) => void
}

type VoiceStatus = 'idle' | 'starting' | 'listening' | 'stopping'

type VoiceState = {
  status: VoiceStatus
  /** Phrases waiting on the speech model. */
  pending: number
  error: DictationError | null
  /** Set when the voice model must be installed before dictation can work. */
  needsSetup: boolean
  clearError: () => void
  clearSetup: () => void
}

export const useVoiceInput = create<VoiceState>((set) => ({
  status: 'idle',
  pending: 0,
  error: null,
  needsSetup: false,
  clearError: () => set({ error: null }),
  clearSetup: () => set({ needsSetup: false }),
}))

let session: DictationSession | null = null
let recorder: Recorder | null = null
let anchor: DictationAnchor | null = null
let insertedLength = 0
let io: ComposerIo | null = null

/** The microphone level (0..1) of the current recording, for a meter. */
export function voiceLevel(): number {
  return recorder?.level ?? 0
}

/** Whether this window can record at all. */
export function voiceInputSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== 'undefined'
  )
}

export async function startDictation(composer: ComposerIo): Promise<void> {
  if (session) return
  io = composer
  anchor = captureAnchor(composer.getValue(), composer.getCaret())
  insertedLength = 0
  recorder = createBrowserRecorder()
  const active = new DictationSession(
    {
      recorder,
      transcribe: (wav, options) => transcribeWav(wav, options),
      isModelMissing: (error) => error instanceof VoiceModelMissingError,
    },
    {
      onState: (status) => {
        if (session === active) useVoiceInput.setState({ status })
      },
      onPending: (pending) => useVoiceInput.setState({ pending }),
      onTranscript: (committed) => {
        if (!anchor || !io) return
        const merged = mergeDictation(anchor, committed)
        insertedLength = merged.insertedLength
        io.apply(merged.value, merged.caret)
      },
      onError: (error) =>
        useVoiceInput.setState({
          error,
          needsSetup: error.kind === 'model-missing',
        }),
    }
  )
  session = active
  useVoiceInput.setState({ error: null, pending: 0 })
  await active.start()
  // The microphone could not be opened: nothing is running.
  if (active.current === 'idle' && session === active) release()
}

function release(): void {
  session = null
  recorder = null
  anchor = null
  io = null
  insertedLength = 0
  useVoiceInput.setState({ status: 'idle', pending: 0 })
}

/** Press the microphone again: keep what was said. */
export async function stopDictation(): Promise<void> {
  const active = session
  if (!active) return
  await active.stop()
  if (session === active) release()
}

/** Throw the dictation away and put the box back as it was, unless it was edited meanwhile. */
export async function cancelDictation(): Promise<void> {
  const active = session
  if (!active) return
  const composer = io
  const start = anchor
  const length = insertedLength
  await active.cancel()
  if (composer && start && length > 0) {
    const reverted = revertDictation(composer.getValue(), start, length)
    if (reverted) composer.apply(reverted.value, reverted.caret)
  }
  if (session === active) release()
}
