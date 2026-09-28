import {
  useInterfaceSettings,
  type CompletionSound,
} from '@/hooks/useInterfaceSettings'

/** Served from `public/sounds`. */
export const COMPLETION_SOUND_URL = '/sounds/answer-finished.mp3'

/**
 * Several runs can end together (a team's children, split panes). One sound
 * says "something finished"; a burst of them says nothing more.
 */
const MIN_GAP_MS = 1500

let lastPlayedAt = 0
let audio: HTMLAudioElement | null = null

/** Is Flint out of view: another window focused, or this one hidden? */
export function appInBackground(doc: Document | undefined = globalThis.document): boolean {
  if (!doc) return false
  if (doc.visibilityState === 'hidden') return true
  return typeof doc.hasFocus === 'function' ? !doc.hasFocus() : false
}

/** Whether the setting asks for a sound right now. */
export function shouldPlayCompletionSound(
  mode: CompletionSound,
  inBackground: boolean
): boolean {
  if (mode === 'always') return true
  if (mode === 'background') return inBackground
  return false
}

/**
 * Play the sound at the chosen volume, ignoring the setting. Used by the
 * settings page's preview (`force`, so each press plays) and by
 * `notifyAnswerFinished`.
 */
export function playCompletionSound(
  volume: number,
  { now = Date.now(), force = false }: { now?: number; force?: boolean } = {}
): void {
  if (!force && now - lastPlayedAt < MIN_GAP_MS) return
  if (typeof Audio === 'undefined') return
  lastPlayedAt = now
  try {
    audio ??= new Audio(COMPLETION_SOUND_URL)
    audio.volume = Math.min(1, Math.max(0, volume))
    audio.currentTime = 0
    // A sound is a nicety: a blocked autoplay or a missing device is not an error.
    void audio.play()?.catch(() => undefined)
  } catch {
    // As above.
  }
}

/**
 * A reply or a run finished on its own (not stopped, not failed): play the
 * sound if the user asked for one in this situation.
 */
export function notifyAnswerFinished(): void {
  const { completionSound, completionSoundVolume } = useInterfaceSettings.getState()
  if (!shouldPlayCompletionSound(completionSound, appInBackground())) return
  playCompletionSound(completionSoundVolume)
}

/** For tests. */
export function resetCompletionSoundForTests(): void {
  lastPlayedAt = 0
  audio = null
}
