/**
 * Stand-in for `@tauri-apps/api/core` in the browser build served by
 * `flint serve` (aliased in vite.config.ts when IS_WEB_APP is set).
 *
 * The app's bundled extensions and plugin wrappers call `invoke(command, args)`
 * straight into Tauri. Here the same call becomes `POST /api/v1/rpc/<command>`,
 * which the server answers for the small set of commands it supports and
 * refuses for everything else.
 */

import { DESKTOP_ONLY_COMMANDS } from '@/lib/desktopOnlyCommands'

type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array

export class Channel<T = unknown> {
  onmessage: (message: T) => void = () => {}
  toJSON(): string {
    throw new Error('Streaming channels are not available in the browser build')
  }
}

export function isTauri(): boolean {
  return false
}

export function convertFileSrc(filePath: string): string {
  return filePath
}

/**
 * Desktop-only commands (desktopOnlyCommands.ts) have no server route, so they
 * are refused here without a request rather than adding a 404 per call.
 */
const UNKNOWN_COMMAND = 'Unknown command'
/** Commands the server answered "Unknown command" for: not asked again. */
const refused = new Set<string>(DESKTOP_ONLY_COMMANDS.keys())

export async function invoke<T = unknown>(command: string, args?: InvokeArgs): Promise<T> {
  if (refused.has(command)) throw new Error(UNKNOWN_COMMAND)
  const response = await fetch(`/api/v1/rpc/${encodeURIComponent(command)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args && typeof args === 'object' && !Array.isArray(args) ? args : {}),
  })
  if (response.status === 401 || response.redirected) {
    window.location.assign('/login')
    throw new Error('Sign in required')
  }
  if (!response.ok) {
    const body = await response.text()
    if (response.status === 404 && body === UNKNOWN_COMMAND) refused.add(command)
    // Tauri rejects with the command's own error value. The plugin's errors are
    // objects, which callers inspect, so a JSON object body is passed on as is.
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object') throw parsed
    } catch (error) {
      if (error && typeof error === 'object' && !(error instanceof SyntaxError)) throw error
    }
    throw new Error(body || `${command} failed (${response.status})`)
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}
