import { MAX_PROMPT_CHARS } from './constants'

/**
 * What a widget may ask of the app. The widget's code is the model's, so each
 * request is treated as untrusted: this is the host's check, not the
 * widget's. A click inside a cross-origin frame gives the parent window
 * transient user activation, which a script cannot fake.
 */
export type BridgeState = { lastPromptAt: number; sent: number }

export const newBridgeState = (): BridgeState => ({ lastPromptAt: 0, sent: 0 })

/** One prompt per activation window, and a hard cap per mounted widget. */
export const PROMPT_MIN_INTERVAL_MS = 4000
export const MAX_PROMPTS_PER_WIDGET = 6

export type PromptCheck =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-gesture' | 'empty' | 'too-long' | 'rate-limited' }

export function checkSendPrompt(
  text: string,
  env: { userActive: boolean; now: number },
  state: BridgeState
): PromptCheck {
  if (!env.userActive) return { ok: false, reason: 'no-gesture' }
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: 'empty' }
  if (trimmed.length > MAX_PROMPT_CHARS) return { ok: false, reason: 'too-long' }
  if (
    state.sent >= MAX_PROMPTS_PER_WIDGET ||
    env.now - state.lastPromptAt < PROMPT_MIN_INTERVAL_MS
  ) {
    return { ok: false, reason: 'rate-limited' }
  }
  state.lastPromptAt = env.now
  state.sent += 1
  return { ok: true, text: trimmed }
}

/** http(s) only, no credentials, and only after a user gesture. */
export function checkOpenLink(
  url: string,
  env: { userActive: boolean }
): { ok: true; url: string } | { ok: false } {
  if (!env.userActive) return { ok: false }
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false }
    if (u.username || u.password) return { ok: false }
    return { ok: true, url: u.href }
  } catch {
    return { ok: false }
  }
}

/** The page's own view of whether the user just interacted with it. */
export function userIsActive(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  return Boolean(
    (nav as (Navigator & { userActivation?: { isActive: boolean } }) | undefined)
      ?.userActivation?.isActive
  )
}
