/**
 * The agent's interactive `browser` tool, renderer side.
 *
 * The browser itself is a separate, throwaway, confined Chromium started by
 * the backend (`browser/session.rs` in the agent-tools crate): Flint's own
 * webview and profile are never involved. This module is the part that needs
 * the user -- the approval for acting on a page -- and the read-only mirror
 * that lets the user watch what the agent is doing (`useBrowserToolMirror`).
 *
 * The backend classifies every call too and refuses what the renderer did not
 * vouch for, so nothing here is trusted to have asked.
 */
import { invoke } from '@tauri-apps/api/core'

export const BROWSER_TOOL_NAME = 'browser'

/** The event the backend announces the agent's browser activity on. */
export const BROWSER_TOOL_EVENT = 'browser-tool-activity'

/**
 * How a call is gated, mirroring `browser_tool::class_of` in Rust:
 * looking at a page the run already opened runs without asking; acting on it
 * is asked like a write; `open` and `evaluate` are asked every time.
 */
export type BrowserCallClass = 'read' | 'act' | 'open' | 'evaluate'

const READ_ACTIONS = new Set([
  'snapshot',
  'screenshot',
  'console',
  'wait',
  'scroll',
  'close',
])

export function browserCallClass(input: unknown): BrowserCallClass {
  const action =
    input && typeof input === 'object'
      ? (input as { action?: unknown }).action
      : undefined
  const name = typeof action === 'string' ? action.trim().toLowerCase() : ''
  if (READ_ACTIONS.has(name)) return 'read'
  if (name === 'open') return 'open'
  if (name === 'evaluate') return 'evaluate'
  // A missing or unknown action counts as acting, never as looking.
  return 'act'
}

/** Asked every time, whatever a grant or a mode says. */
export const browserAlwaysAsks = (c: BrowserCallClass): boolean =>
  c === 'open' || c === 'evaluate'

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

/** What the user is shown when the backend cannot name the target. */
export function localBrowserSummary(input: unknown): string {
  const a = (input && typeof input === 'object' ? input : {}) as Record<
    string,
    unknown
  >
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  const action = s('action') || '?'
  switch (action) {
    case 'open':
      return `browser open ${clip(s('url') || '?', 200)}`
    case 'type':
      return `browser type into ${s('ref') || '?'} (${s('text').length} characters)`
    case 'press':
      return `browser press ${clip(s('key') || '?', 40)}`
    case 'evaluate':
      return `browser evaluate script in the page: ${clip(s('expression') || '?', 300)}`
    default:
      return s('ref') ? `browser ${action} ${s('ref')}` : `browser ${action}`
  }
}

/**
 * One line naming what the call will do, with the element named as the last
 * snapshot called it. Asked of the backend, which holds the snapshot; falls
 * back to the call's own words.
 */
export async function describeBrowserCall(
  input: unknown,
  threadId: string,
  ask: (threadId: string, input: unknown) => Promise<string> = (id, i) =>
    invoke<string>('browser_tool_describe', { threadId: id, input: i })
): Promise<string> {
  try {
    const line = await ask(threadId, input)
    if (line) return line
  } catch {
    // The summary is a convenience; the question is still asked.
  }
  return localBrowserSummary(input)
}

/**
 * End the agent browser of a conversation or Cowork session: its run ended,
 * the user switched away, or the thread was deleted. Best effort and quiet --
 * there is usually nothing to close, and this must never fail a run's ending.
 */
export async function closeBrowserSession(
  id: string | null | undefined,
  close: (id: string) => Promise<unknown> = (i) =>
    invoke('browser_tool_close', { id: i })
): Promise<void> {
  if (!id) return
  try {
    await close(id)
  } catch {
    // Not in the desktop app, or already gone.
  }
}

/** The arguments as shown in a prompt: typed text is a count, not the text. */
export function browserInputForPrompt(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const a = { ...(input as Record<string, unknown>) }
  if (typeof a.text === 'string' && a.action === 'type') {
    a.text = `[${a.text.length} characters]`
  }
  return a
}
