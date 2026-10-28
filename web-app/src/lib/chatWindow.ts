import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getAllWebviewWindows } from '@tauri-apps/api/webviewWindow'
import { create } from 'zustand'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import type { SplitTarget } from '@/hooks/useSplitConversation'
import {
  SOLO_FLAG,
  initialSoloSession,
  isChatWindow,
  isSoloSpare,
} from '@/lib/soloFlag'

/**
 * "New window" on a conversation: a second app window that shows only that
 * conversation -- no sidebar, no header actions, and no way to reach another
 * page (see `components/solo`).
 *
 * Opening one used to boot the whole app in a fresh webview, which is slow. A
 * spare window is therefore kept hidden, already booted and idle, and
 * "New window" hands it the conversation and shows it. Only one spare exists
 * at a time; with none ready the window is created the old way.
 */

export { isChatWindow, isSoloSpare }

export const CHAT_WINDOW_LABEL_PREFIX = 'chat-window-'
/** Must match `SPARE_LABEL_PREFIX` in src-tauri/src/core/solo_window.rs. */
export const SPARE_LABEL_PREFIX = `${CHAT_WINDOW_LABEL_PREFIX}spare-`

/** The path a spare idles on; no route renders there. */
export const SOLO_IDLE_PATH = '/solo'

export const SOLO_EVENT = {
  /** spare -> main: booted and idle (payload: its label). */
  ready: 'solo-spare-ready',
  /** main -> spare: show this conversation (payload: SoloAssignment). */
  assign: 'solo-assign',
  /** spare -> main: the conversation is on screen (payload: SoloShown). */
  shown: 'solo-shown',
  /** spare -> main: could not show the conversation (payload: its label). */
  failed: 'solo-failed',
} as const

/** `label` names the spare the assignment is for: events reach every window. */
export type SoloAssignment = {
  target: SplitTarget
  label: string
  t0?: number
}
export type SoloShown = { label: string }

// --- pure helpers -----------------------------------------------------------

/** The pathname a conversation lives at inside a solo window. */
export function soloPath(target: SplitTarget): string {
  const ref = encodeURIComponent(target.refId ?? '')
  if (target.kind === 'chat') return `/threads/${ref}`
  if (target.kind === 'room') return `/rooms/${ref}`
  return '/cowork'
}

/** The URL a new window loads for a conversation. */
export function chatWindowUrl(target: SplitTarget): string {
  const q = new URLSearchParams({ [SOLO_FLAG]: '1' })
  if (target.kind === 'cowork') q.set('session', target.refId ?? '')
  return `${soloPath(target)}?${q}`
}

/** The URL a spare idles on. */
export function spareUrl(): string {
  const q = new URLSearchParams({ [SOLO_FLAG]: '1', spare: '1' })
  return `${SOLO_IDLE_PATH}?${q}`
}

/** What a solo window was opened for, read from its own location. */
export function parseSoloTarget(
  pathname: string,
  search: string
): SplitTarget | null {
  const thread = /^\/threads\/([^/]+)\/?$/.exec(pathname)
  if (thread) return { kind: 'chat', refId: decodeURIComponent(thread[1]) }
  const room = /^\/rooms\/([^/]+)\/?$/.exec(pathname)
  if (room) return { kind: 'room', refId: decodeURIComponent(room[1]) }
  if (pathname === '/cowork') {
    const session = new URLSearchParams(search).get('session')
    return session ? { kind: 'cowork', refId: session } : null
  }
  return null
}

/**
 * Whether a solo window may show `pathname`: its own conversation, or the idle
 * page while it has none. Everything else is out of reach.
 */
export function isAllowedSoloPath(
  pathname: string,
  target: SplitTarget | null
): boolean {
  const bare = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (!target) return bare === SOLO_IDLE_PATH
  return bare === soloPath(target)
}

export type SpareState = { label: string; ready: boolean } | null

/** Hand the conversation to the spare when one is ready, else cold start. */
export function planOpen(spare: SpareState): 'warm' | 'cold' {
  return spare?.ready ? 'warm' : 'cold'
}

// --- the window's own conversation -----------------------------------------

type SoloTargetState = {
  target: SplitTarget | null
  setTarget: (target: SplitTarget | null) => void
}

/** The conversation this window shows. Null in a spare until it is assigned. */
export const useSoloTarget = create<SoloTargetState>((set) => ({
  target:
    typeof window === 'undefined' || !isChatWindow()
      ? null
      : parseSoloTarget(window.location.pathname, window.location.search),
  setTarget: (target) => set({ target }),
}))

/** Select the Cowork session a chat window was opened for. Idempotent. */
export function applyChatWindowSession(session?: string | null) {
  const id = session ?? initialSoloSession()
  if (!isChatWindow() || !id) return
  const store = useCoworkSessions.getState()
  if (store.currentId !== id) store.selectSession(id)
}

// --- the main window's side -------------------------------------------------

let spare: SpareState = null
let leftoversSwept = false
let readyUnlisten: UnlistenFn | null = null
let nextTimer: ReturnType<typeof setTimeout> | undefined

/** How long a spare has to show the conversation before it is given up on. */
const ASSIGN_TIMEOUT_MS = 4000
/** Pause before the next spare is built, so opening a window stays smooth. */
const NEXT_SPARE_DELAY_MS = 1200

const freshLabel = () => `${CHAT_WINDOW_LABEL_PREFIX}${Date.now().toString(36)}`

async function ensureReadyListener() {
  if (readyUnlisten) return
  readyUnlisten = await listen<string>(SOLO_EVENT.ready, (e) => {
    if (spare && spare.label === e.payload) spare = { ...spare, ready: true }
  })
}

/**
 * Close hidden spares an earlier load of this main window built. The spare
 * this module tracks is forgotten on a reload, so without this every reload
 * left one more hidden window running until the app quit. A spare already
 * showing a conversation is visible and is left alone.
 */
async function closeLeftoverSpares(): Promise<void> {
  if (leftoversSwept) return
  leftoversSwept = true
  try {
    for (const w of await getAllWebviewWindows()) {
      if (!w.label.startsWith(SPARE_LABEL_PREFIX)) continue
      if (await w.isVisible().catch(() => true)) continue
      await w.close().catch(() => {})
    }
  } catch (err) {
    console.warn('Could not close leftover spare windows:', err)
  }
}

/**
 * Build the spare: a hidden window on the idle entry. Called by the main
 * window once it is idle; a no-op where a spare exists already or in a solo
 * window itself.
 */
export async function prewarmSoloWindow(): Promise<void> {
  if (!IS_TAURI || isChatWindow() || spare) return
  await closeLeftoverSpares()
  if (spare) return
  const label = `${SPARE_LABEL_PREFIX}${Date.now().toString(36)}`
  spare = { label, ready: false }
  try {
    await ensureReadyListener()
    await getServiceHub().window().createWebviewWindow({
      url: spareUrl(),
      label,
      title: 'Flint',
      width: 1100,
      height: 800,
      center: true,
      resizable: true,
      visible: false,
    })
  } catch (err) {
    console.warn('Could not prepare a spare window:', err)
    if (spare?.label === label) spare = null
  }
}

function scheduleNextSpare() {
  clearTimeout(nextTimer)
  nextTimer = setTimeout(() => void prewarmSoloWindow(), NEXT_SPARE_DELAY_MS)
}

async function assignToSpare(
  label: string,
  target: SplitTarget,
  t0: number
): Promise<boolean> {
  let unlisten: UnlistenFn | undefined
  let unlistenFailed: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settle: (ok: boolean) => void = () => {}
  const shown = new Promise<boolean>((resolve) => {
    settle = resolve
  })
  try {
    // Both listeners are registered before the spare is asked to answer, and
    // before any unlisten can be needed, so none is left behind.
    unlisten = await listen<SoloShown>(SOLO_EVENT.shown, (e) => {
      if (e.payload?.label === label) settle(true)
    })
    // A spare that cannot show itself says so, and the open falls back at
    // once instead of waiting out the timeout.
    unlistenFailed = await listen<string>(SOLO_EVENT.failed, (e) => {
      if (e.payload === label) settle(false)
    })
    timer = setTimeout(() => settle(false), ASSIGN_TIMEOUT_MS)
    const payload: SoloAssignment = { target, label, t0 }
    await emitTo(label, SOLO_EVENT.assign, payload)
    return await shown
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    unlisten?.()
    unlistenFailed?.()
  }
}

async function coldOpen(target: SplitTarget): Promise<void> {
  await getServiceHub()
    .window()
    .createWebviewWindow({
      url: chatWindowUrl(target),
      label: freshLabel(),
      title: 'Flint',
      width: 1100,
      height: 800,
      center: true,
      resizable: true,
    })
}

/** "New window": the conversation, alone, in a window of its own. */
export async function openChatWindow(target: SplitTarget): Promise<void> {
  const t0 = performance.now()
  const state = spare
  if (state && planOpen(state) === 'warm') {
    spare = null
    const ok = await assignToSpare(state.label, target, t0)
    if (ok) {
      console.info(
        `[solo] warm open: click -> visible ${Math.round(performance.now() - t0)}ms`
      )
      scheduleNextSpare()
      return
    }
    // The spare did not answer: drop it and open the usual way.
    try {
      const w = await getServiceHub()
        .window()
        .getWebviewWindowByLabel(state.label)
      await w?.close()
    } catch {
      /* already gone */
    }
  }
  await coldOpen(target)
  console.info(
    `[solo] cold open: click -> window created ${Math.round(performance.now() - t0)}ms`
  )
  scheduleNextSpare()
}

/** Test seam. */
export const __testing = {
  reset() {
    spare = null
    leftoversSwept = false
    readyUnlisten = null
    clearTimeout(nextTimer)
  },
  setSpare(next: SpareState) {
    spare = next
  },
}
