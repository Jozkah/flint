// Dictation on the phone: record with the microphone, encode 16 kHz mono WAV,
// and let the computer transcribe it with its voice model. Press to start,
// press again to keep the words, Escape to throw the recording away.

import { useEffect, useRef, useState } from 'react'
import { createBrowserRecorder, type Recorder } from '@/lib/voice/recorder'
import { Resampler, TARGET_RATE } from '@/lib/voice/resample'
import { encodeWav, toBase64 } from '@/lib/voice/wav'
import { RemoteCallError } from '../api/client'
import { client, openSheet, toast } from '../state/app'
import { useRpc } from '../state/rpc'
import { I } from './icons'
import { t } from '../i18n'

/** Longest recording sent: the computer accepts about 2.5 minutes. */
export const MAX_DICTATION_SECONDS = 120

/** `text` put in `value` at the selection, with a space either side when needed. */
export function insertAt(value: string, start: number, end: number, text: string) {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  const piece = lead + text + trail
  return { value: before + piece + after, caret: before.length + piece.length }
}

/** Why recording is not possible here, or null when it is. */
export function micUnavailable(): string | null {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return t('dictate.secure')
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return t('dictate.noRecording')
  }
  return null
}

type Phase = 'idle' | 'recording' | 'sending'

export function DictateButton({
  insert,
  style,
}: {
  /** Puts the transcribed words in the text box at the caret. */
  insert: (text: string) => void
  style?: React.CSSProperties
}) {
  const status = useRpc('voice.status', {})
  const [phase, setPhase] = useState<Phase>('idle')
  const rec = useRef<{ recorder: Recorder; chunks: Float32Array[]; resampler: Resampler | null; samples: number } | null>(null)
  const insertRef = useRef(insert)
  insertRef.current = insert

  const discard = async () => {
    const r = rec.current
    rec.current = null
    setPhase('idle')
    await r?.recorder.stop()
  }

  const finish = async () => {
    const r = rec.current
    if (!r) return
    rec.current = null
    await r.recorder.stop()
    if (!r.samples) {
      setPhase('idle')
      return
    }
    setPhase('sending')
    const all = new Float32Array(r.samples)
    let at = 0
    for (const c of r.chunks) {
      all.set(c, at)
      at += c.length
    }
    try {
      const { text } = await client().rpc('voice.transcribe', { audio: toBase64(encodeWav(all, TARGET_RATE)) })
      if (text) insertRef.current(text)
      else toast(t('dictate.noWords'))
    } catch (e) {
      if (e instanceof RemoteCallError && e.code === 'not_ready') openSheet('voicesetup')
      else toast(e instanceof Error ? e.message : t('dictate.failed'))
    } finally {
      setPhase('idle')
    }
  }

  const begin = async () => {
    if (!status.data?.ready) return openSheet('voicesetup')
    const why = micUnavailable()
    if (why) return toast(why)
    const recorder = createBrowserRecorder()
    const r = { recorder, chunks: [] as Float32Array[], resampler: null as Resampler | null, samples: 0 }
    rec.current = r
    setPhase('recording')
    try {
      await recorder.start((mono, rate) => {
        if (rec.current !== r) return
        r.resampler ??= new Resampler(rate)
        const out = r.resampler.process(mono)
        r.chunks.push(out)
        r.samples += out.length
        if (r.samples >= MAX_DICTATION_SECONDS * TARGET_RATE) void finish()
      })
    } catch (e) {
      rec.current = null
      setPhase('idle')
      toast(e instanceof Error ? e.message : t('dictate.micFailed'))
    }
  }

  // Escape throws the recording away; leaving the screen does too.
  useEffect(() => {
    if (phase !== 'recording') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void discard().then(() => toast(t('dictate.discarded')))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase])
  useEffect(() => () => void rec.current?.recorder.stop(), [])

  const label = phase === 'recording' ? t('dictate.stop') : phase === 'sending' ? t('dictate.transcribing') : t('dictate.start')
  return (
    <button
      type="button"
      className={`send dict${phase === 'recording' ? ' rec' : ''}`}
      aria-label={label}
      title={phase === 'recording' ? t('dictate.hint') : label}
      disabled={phase === 'sending'}
      data-testid="dictate"
      style={style}
      onClick={() => void (phase === 'recording' ? finish() : phase === 'idle' ? begin() : undefined)}
    >
      <I n={phase === 'sending' ? 'loader' : phase === 'recording' ? 'sq' : 'mic'} />
    </button>
  )
}

/** A text box's `insert`: words at the caret, the caret after them. */
export function insertInto(
  el: HTMLTextAreaElement | null,
  value: string,
  set: (v: string) => void,
  text: string
) {
  const start = el?.selectionStart ?? value.length
  const end = el?.selectionEnd ?? value.length
  const next = insertAt(value, start, end, text)
  set(next.value)
  requestAnimationFrame(() => {
    if (!el) return
    el.focus()
    el.setSelectionRange(next.caret, next.caret)
  })
}
