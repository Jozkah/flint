import { describe, expect, it } from 'vitest'
import { EnergyVad, FRAME_SAMPLES, SAMPLE_RATE, frameDb } from '@/lib/voice/vad'
import { Resampler, TARGET_RATE, downmix, lowPassTaps } from '@/lib/voice/resample'
import { encodeWav, toBase64 } from '@/lib/voice/wav'
import {
  cleanTranscript,
  isPlausibleTranscript,
  stripEchoedLanguage,
} from '@/lib/voice/transcript'
import {
  appendSegment,
  captureAnchor,
  joinSegment,
  mergeDictation,
  revertDictation,
} from '@/lib/voice/promptMerge'

const tone = (seconds: number, amp: number, rate = SAMPLE_RATE, hz = 440) =>
  Float32Array.from(
    { length: Math.round(seconds * rate) },
    (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate)
  )
const silence = (seconds: number, rate = SAMPLE_RATE) =>
  new Float32Array(Math.round(seconds * rate))
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

describe('EnergyVad', () => {
  it('cuts one phrase out of speech between silences', () => {
    const vad = new EnergyVad()
    const audio = concat(silence(0.6), tone(1.2, 0.3), silence(1.2))
    const phrases = vad.push(audio)
    expect(phrases).toHaveLength(1)
    const seconds = phrases[0].length / SAMPLE_RATE
    // The speech plus pre-roll and the quiet that closed it.
    expect(seconds).toBeGreaterThan(1.2)
    expect(seconds).toBeLessThan(2.6)
  })

  it('finds two phrases when the pause is long enough, one when it is short', () => {
    const long = new EnergyVad().push(
      concat(silence(0.6), tone(1, 0.3), silence(1), tone(1, 0.3), silence(1))
    )
    expect(long).toHaveLength(2)
    const short = new EnergyVad().push(
      concat(silence(0.6), tone(1, 0.3), silence(0.3), tone(1, 0.3), silence(1))
    )
    expect(short).toHaveLength(1)
  })

  it('drops a blip too short to be a word', () => {
    const phrases = new EnergyVad().push(
      concat(silence(0.6), tone(0.1, 0.3), silence(1.5))
    )
    expect(phrases).toHaveLength(0)
  })

  it('is the same however the audio is chunked', () => {
    const audio = concat(silence(0.6), tone(1, 0.3), silence(1.2))
    const whole = new EnergyVad().push(audio)
    const vad = new EnergyVad()
    const pieces: Float32Array[] = []
    for (let i = 0; i < audio.length; i += 777) {
      pieces.push(...vad.push(audio.slice(i, i + 777)))
    }
    expect(pieces).toHaveLength(whole.length)
    expect(pieces[0].length).toBe(whole[0].length)
  })

  it('cuts a very long phrase at the limit and keeps going', () => {
    const phrases = new EnergyVad().push(
      concat(silence(0.6), tone(20, 0.3), silence(1.2))
    )
    expect(phrases.length).toBeGreaterThanOrEqual(2)
    expect(phrases[0].length / SAMPLE_RATE).toBeLessThanOrEqual(15.1)
  })

  it('hands back a phrase still in progress on flush', () => {
    const vad = new EnergyVad()
    expect(vad.push(concat(silence(0.6), tone(1.5, 0.3)))).toHaveLength(0)
    expect(vad.flush()).not.toBeNull()
    expect(vad.flush()).toBeNull()
  })

  it('measures loudness in dBFS', () => {
    expect(frameDb(new Float32Array(FRAME_SAMPLES))).toBe(-100)
    expect(frameDb(tone(0.02, 1))).toBeCloseTo(-3, 0)
  })
})

describe('Resampler', () => {
  it('turns 48 kHz into a third as many samples at 16 kHz', () => {
    const r = new Resampler(48_000)
    const out = r.process(tone(1, 0.5, 48_000, 440))
    expect(out.length).toBeGreaterThan(15_800)
    expect(out.length).toBeLessThanOrEqual(16_000)
  })

  it('keeps a speech-band tone at about the same loudness', () => {
    const out = new Resampler(48_000).process(tone(1, 0.5, 48_000, 440))
    const settled = out.slice(2_000, 14_000)
    expect(frameDb(settled)).toBeCloseTo(frameDb(tone(0.75, 0.5, 16_000, 440)), 0)
  })

  it('removes a tone above what 16 kHz can hold instead of folding it back', () => {
    const out = new Resampler(48_000).process(tone(1, 0.5, 48_000, 20_000))
    expect(frameDb(out.slice(2_000, 14_000))).toBeLessThan(-30)
  })

  it('gives the same result however the input is split', () => {
    const input = tone(0.5, 0.5, 44_100, 600)
    const whole = new Resampler(44_100).process(input)
    const r = new Resampler(44_100)
    const parts: Float32Array[] = []
    for (let i = 0; i < input.length; i += 1000) parts.push(r.process(input.slice(i, i + 1000)))
    const joined = concat(...parts)
    expect(joined.length).toBe(whole.length)
    for (let i = 0; i < whole.length; i += 97) expect(joined[i]).toBeCloseTo(whole[i], 5)
  })

  it('passes 16 kHz through, and has unity gain at DC', () => {
    const input = tone(0.1, 0.5)
    expect(new Resampler(TARGET_RATE).process(input)).toBe(input)
    expect(lowPassTaps(48_000).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5)
  })

  it('averages channels', () => {
    const mono = downmix([Float32Array.of(1, 0), Float32Array.of(0, 1)])
    expect(Array.from(mono)).toEqual([0.5, 0.5])
  })
})

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM header and clamps samples', () => {
    const wav = encodeWav(Float32Array.of(0, 1, -1, 2), 16_000)
    const view = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(40, true)).toBe(8)
    expect(view.getInt16(46, true)).toBe(32767)
    expect(view.getInt16(48, true)).toBe(-32768)
    expect(view.getInt16(50, true)).toBe(32767)
    expect(wav.length).toBe(44 + 8)
  })

  it('encodes base64 of any length', () => {
    expect(toBase64(Uint8Array.of(72, 105))).toBe('SGk=')
    expect(atob(toBase64(new Uint8Array(100_000).fill(7))).length).toBe(100_000)
  })
})

describe('transcript checks', () => {
  it('accepts a normal transcript and rejects answers and runaway text', () => {
    expect(isPlausibleTranscript('Hello there, how are you?', 3)).toBe(true)
    expect(isPlausibleTranscript('   ', 3)).toBe(false)
    expect(isPlausibleTranscript('```\ncode\n```', 3)).toBe(false)
    expect(isPlausibleTranscript('a\nb\nc\nd', 30)).toBe(false)
    expect(isPlausibleTranscript('x'.repeat(500), 2)).toBe(false)
  })

  it('removes an echoed language instruction and tidies spaces', () => {
    expect(stripEchoedLanguage('lang:fr Bonjour')).toBe('Bonjour')
    expect(stripEchoedLanguage('Bonjour lang:fr')).toBe('Bonjour lang:fr')
    expect(cleanTranscript('lang:en  hello\n  world ')).toBe('hello world')
  })
})

describe('promptMerge', () => {
  it('joins phrases with one space and lets punctuation hug the word', () => {
    expect(joinSegment('Hello', 'world')).toBe('Hello world')
    expect(joinSegment('Hello ', 'world')).toBe('Hello world')
    expect(joinSegment('Hello', ', world')).toBe('Hello, world')
    expect(joinSegment('', 'world')).toBe('world')
    expect(appendSegment('one', '  two  ')).toBe('one two')
    expect(appendSegment('one', '   ')).toBe('one')
  })

  it('splices at the caret and keeps the text after it', () => {
    const anchor = captureAnchor('Say  now', 4)
    expect(anchor).toEqual({ before: 'Say ', after: ' now' })
    const merged = mergeDictation(anchor, 'hi there')
    expect(merged.value).toBe('Say hi there now')
    expect(merged.caret).toBe('Say hi there'.length)
    expect(mergeDictation(anchor, 'hi there')).toEqual(merged)
  })

  it('appends at the end when there is no caret', () => {
    expect(captureAnchor('abc', null)).toEqual({ before: 'abc', after: '' })
    expect(mergeDictation(captureAnchor('abc', null), 'def').value).toBe('abc def')
  })

  it('does not fuse the tail onto the last dictated word', () => {
    const anchor = captureAnchor('Fix the thing', 7)
    expect(mergeDictation(anchor, 'quick').value).toBe('Fix the quick thing')
  })

  it('reverts what it inserted, and refuses when the user typed meanwhile', () => {
    const anchor = captureAnchor('A B', 2)
    const merged = mergeDictation(anchor, 'middle')
    expect(revertDictation(merged.value, anchor, merged.insertedLength)).toEqual({
      value: 'A B',
      caret: 2,
    })
    expect(revertDictation(merged.value + '!', anchor, merged.insertedLength)).toBeNull()
    expect(revertDictation('short', anchor, 99)).toBeNull()
  })
})
