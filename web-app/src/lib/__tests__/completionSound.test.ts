import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  appInBackground,
  notifyAnswerFinished,
  playCompletionSound,
  resetCompletionSoundForTests,
  shouldPlayCompletionSound,
} from '@/lib/completionSound'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'

const play = vi.fn(() => Promise.resolve())
const created: Array<{ volume: number; src: string }> = []

class FakeAudio {
  volume = 1
  currentTime = 0
  constructor(public src: string) {
    created.push(this)
  }
  play = play
}

describe('completion sound', () => {
  beforeEach(() => {
    play.mockClear()
    created.length = 0
    resetCompletionSoundForTests()
    vi.stubGlobal('Audio', FakeAudio)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('plays per the setting', () => {
    expect(shouldPlayCompletionSound('off', true)).toBe(false)
    expect(shouldPlayCompletionSound('background', false)).toBe(false)
    expect(shouldPlayCompletionSound('background', true)).toBe(true)
    expect(shouldPlayCompletionSound('always', false)).toBe(true)
  })

  it('counts a hidden or unfocused window as background', () => {
    const doc = (hidden: boolean, focused: boolean) =>
      ({ visibilityState: hidden ? 'hidden' : 'visible', hasFocus: () => focused }) as Document
    expect(appInBackground(doc(true, true))).toBe(true)
    expect(appInBackground(doc(false, false))).toBe(true)
    expect(appInBackground(doc(false, true))).toBe(false)
  })

  it('plays the bundled sound at the chosen volume, once per burst', () => {
    playCompletionSound(0.4, { now: 10_000 })
    playCompletionSound(0.4, { now: 10_500 })
    expect(play).toHaveBeenCalledTimes(1)
    expect(created[0].src).toBe('/sounds/answer-finished.mp3')
    expect(created[0].volume).toBe(0.4)
    playCompletionSound(0.4, { now: 12_000 })
    expect(play).toHaveBeenCalledTimes(2)
    // The preview always plays, and does not hold back the next real sound.
    playCompletionSound(0.4, { now: 12_100, force: true })
    expect(play).toHaveBeenCalledTimes(3)
  })

  it('stays silent when off, and never throws when playback is refused', () => {
    useInterfaceSettings.setState({ completionSound: 'off' })
    notifyAnswerFinished()
    expect(play).not.toHaveBeenCalled()
    useInterfaceSettings.setState({ completionSound: 'always', completionSoundVolume: 0.8 })
    play.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')))
    expect(() => notifyAnswerFinished()).not.toThrow()
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('is off by default', () => {
    expect(useInterfaceSettings.getInitialState().completionSound).toBe('off')
  })
})
