import { describe, expect, it, vi } from 'vitest'
import { DictationSession, type DictationError } from '@/lib/voice/dictation'
import type { AudioChunk, Recorder } from '@/lib/voice/recorder'
import { RecorderError, recorderErrorFrom } from '@/lib/voice/recorder'
import {
  VOICE_CHAT_TEMPLATE,
  VOICE_MODEL_ID,
  languageDirective,
} from '@/lib/voice/voiceModel'
import { completionText, transcriptionRequest } from '@/lib/voice/transcribe'

const RATE = 16_000
const tone = (seconds: number, amp = 0.3) =>
  Float32Array.from(
    { length: Math.round(seconds * RATE) },
    (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / RATE)
  )
const silence = (seconds: number) => new Float32Array(Math.round(seconds * RATE))

function fakeRecorder(opts: { failStart?: unknown } = {}) {
  let sink: AudioChunk | null = null
  const recorder: Recorder & { feed: (a: Float32Array) => void; stopped: number } = {
    level: 0,
    stopped: 0,
    async start(onChunk) {
      if (opts.failStart) throw opts.failStart
      sink = onChunk
    },
    async stop() {
      this.stopped += 1
      sink = null
    },
    feed(audio) {
      // In pieces, the way a microphone delivers it.
      for (let i = 0; i < audio.length; i += 1600) sink?.(audio.slice(i, i + 1600), RATE)
    },
  }
  return recorder
}

const speak = (rec: ReturnType<typeof fakeRecorder>) => {
  rec.feed(silence(0.6))
  rec.feed(tone(1, 0.3))
  rec.feed(silence(1))
}

describe('DictationSession', () => {
  it('adds each phrase to the transcript as it comes back', async () => {
    const rec = fakeRecorder()
    const transcripts: string[] = []
    const transcribe = vi
      .fn<(w: Uint8Array) => Promise<string>>()
      .mockResolvedValueOnce('hello there')
      .mockResolvedValueOnce('lang:en and goodbye')
    const session = new DictationSession(
      { recorder: rec, transcribe },
      { onTranscript: (t) => transcripts.push(t) }
    )
    await session.start()
    expect(session.current).toBe('listening')
    speak(rec)
    speak(rec)
    const final = await session.stop()
    expect(transcripts).toEqual(['hello there', 'hello there and goodbye'])
    expect(final).toBe('hello there and goodbye')
    expect(session.current).toBe('idle')
    expect(rec.stopped).toBeGreaterThan(0)
  })

  it('sends the phrase as a 16 kHz WAV with the chosen language', async () => {
    const rec = fakeRecorder()
    const transcribe = vi.fn().mockResolvedValue('ok')
    const session = new DictationSession({
      recorder: rec,
      transcribe,
      language: () => 'fr',
    })
    await session.start()
    speak(rec)
    await session.stop()
    const [wav, options] = transcribe.mock.calls[0]
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000)
    expect(options).toEqual({ language: 'fr' })
  })

  it('finishes a phrase still being spoken when stopped', async () => {
    const rec = fakeRecorder()
    const transcribe = vi.fn().mockResolvedValue('cut off')
    const session = new DictationSession({ recorder: rec, transcribe })
    await session.start()
    rec.feed(silence(0.6))
    rec.feed(tone(1.5))
    expect(transcribe).not.toHaveBeenCalled()
    expect(await session.stop()).toBe('cut off')
  })

  it('ignores an answer that is not a transcript', async () => {
    const rec = fakeRecorder()
    const transcribe = vi
      .fn()
      .mockResolvedValue('I am unable to transcribe audio.\n\nHere is a guide:\n\n```x```')
    const session = new DictationSession({ recorder: rec, transcribe })
    await session.start()
    speak(rec)
    expect(await session.stop()).toBe('')
  })

  it('stops after two failures in a row and says why', async () => {
    const rec = fakeRecorder()
    const errors: DictationError[] = []
    const transcribe = vi.fn().mockRejectedValue(new Error('engine down'))
    const session = new DictationSession(
      { recorder: rec, transcribe },
      { onError: (e) => errors.push(e) }
    )
    await session.start()
    speak(rec)
    speak(rec)
    speak(rec)
    await session.stop()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toEqual({ kind: 'transcription', message: 'engine down' })
  })

  it('tolerates one failure between good phrases', async () => {
    const rec = fakeRecorder()
    const errors: DictationError[] = []
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce('fine')
    const session = new DictationSession(
      { recorder: rec, transcribe },
      { onError: (e) => errors.push(e) }
    )
    await session.start()
    speak(rec)
    speak(rec)
    expect(await session.stop()).toBe('fine')
    expect(errors).toHaveLength(0)
  })

  it('reports a missing voice model at once', async () => {
    const rec = fakeRecorder()
    const errors: DictationError[] = []
    class Missing extends Error {}
    const session = new DictationSession(
      {
        recorder: rec,
        transcribe: vi.fn().mockRejectedValue(new Missing('no model')),
        isModelMissing: (e) => e instanceof Missing,
      },
      { onError: (e) => errors.push(e) }
    )
    await session.start()
    speak(rec)
    await session.stop()
    expect(errors.map((e) => e.kind)).toEqual(['model-missing'])
  })

  it('reports a microphone that cannot be opened and stays idle', async () => {
    const errors: DictationError[] = []
    const session = new DictationSession(
      {
        recorder: fakeRecorder({ failStart: new RecorderError('denied', 'Refused.') }),
        transcribe: vi.fn(),
      },
      { onError: (e) => errors.push(e) }
    )
    await session.start()
    expect(session.current).toBe('idle')
    expect(errors).toEqual([{ kind: 'recorder', message: 'Refused.' }])
  })

  it('discards everything on cancel', async () => {
    const rec = fakeRecorder()
    const transcribe = vi.fn().mockResolvedValue('never shown')
    const transcripts: string[] = []
    const session = new DictationSession(
      { recorder: rec, transcribe },
      { onTranscript: (t) => transcripts.push(t) }
    )
    await session.start()
    rec.feed(silence(0.6))
    rec.feed(tone(1.5))
    await session.cancel()
    expect(session.current).toBe('idle')
    expect(transcripts).toEqual([])
  })
})

describe('recorder errors', () => {
  it('names a refused and a missing microphone', () => {
    expect(recorderErrorFrom({ name: 'NotAllowedError' }).code).toBe('denied')
    expect(recorderErrorFrom({ name: 'NotFoundError' }).code).toBe('no-device')
    expect(recorderErrorFrom(new Error('boom')).code).toBe('failed')
  })
})

describe('voice model request', () => {
  it('builds a chat completion with the audio and a language instruction', () => {
    const body = transcriptionRequest(Uint8Array.of(1, 2, 3), 'de')
    expect(body.model).toBe(VOICE_MODEL_ID)
    expect(body.temperature).toBe(0)
    const parts = body.messages[0].content
    expect(parts[0]).toMatchObject({
      type: 'input_audio',
      input_audio: { data: 'AQID', format: 'wav' },
    })
    expect(parts[1]).toEqual({ type: 'text', text: 'lang:de' })
  })

  it('leaves the language out for automatic detection', () => {
    expect(transcriptionRequest(Uint8Array.of(1)).messages[0].content).toHaveLength(1)
    expect(languageDirective('auto')).toBe('')
    expect(languageDirective(' EN ')).toBe('lang:en')
    expect(languageDirective('pt-BR')).toBe('lang:pt-br')
  })

  it('reads the text of a completion in either shape', () => {
    expect(completionText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi')
    expect(
      completionText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] })
    ).toBe('ab')
    expect(completionText({})).toBe('')
  })

  it('ends the user turn in the transcription token', () => {
    expect(VOICE_CHAT_TEMPLATE).toContain("'[INST]' + content.text + '[TRANSCRIBE]'")
    expect(VOICE_CHAT_TEMPLATE).not.toContain('system')
  })
})
