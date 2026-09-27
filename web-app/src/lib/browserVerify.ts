/**
 * "Verify in browser": the renderer side of `core::browser_verify`.
 *
 * The run happens in a separate, headless Chrome/Edge with a throwaway
 * profile, confined to the local app's origin -- never in Flint's own
 * webview. This module turns the user's step list into the backend's steps
 * and carries the evidence back.
 */

export type VerifyStep =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; target: string }
  | { kind: 'type'; target: string; text: string }
  | { kind: 'expect'; text: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'screenshot' }

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

export type StepRecord = {
  index: number
  label: string
  status: StepStatus
  detail: string | null
  duration_ms: number
}

export type VerifyReport = {
  id: string
  url: string
  origin: string
  outcome: 'passed' | 'failed' | 'cancelled' | 'error'
  reason: string
  steps: StepRecord[]
  screenshots: { step: number | null; png_base64: string }[]
  console_errors: { kind: string; text: string }[]
  blocked_requests: { url: string; resource_type: string; navigation: boolean }[]
  document_status: number | null
  final_url: string | null
  browser: string | null
  started_at: string
  duration_ms: number
  profile_removed: boolean
}

export type BrowserInfo = {
  found: boolean
  path: string | null
  name: string | null
  hint: string | null
}

export const MAX_STEPS = 30

/** Whether `url` is an app on this machine the verifier will accept. */
export function isLocalAppUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (u.username || u.password) return false
    const h = u.hostname.toLowerCase()
    return h === 'localhost' || h === '[::1]' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
  } catch {
    return false
  }
}

/**
 * One step per line:
 *
 *   open: /settings          (or `go to:`)
 *   click: Sign in           (visible text, or `css:#submit`)
 *   type: Email = a@b.c      (field label/placeholder/name, or `css:...`)
 *   expect: Welcome back
 *   wait: 500
 *   screenshot
 *
 * Blank lines and `#` comments are ignored. Returns the steps, or the first
 * line that could not be read.
 */
export function parseSteps(text: string): { steps: VerifyStep[]; error: string | null } {
  const steps: VerifyStep[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([a-z ]+?)\s*(?::\s*(.*))?$/i.exec(line)
    const verb = m?.[1]?.toLowerCase().trim() ?? ''
    const arg = (m?.[2] ?? '').trim()
    const bad = (why: string) => ({ steps, error: `Line ${i + 1}: ${why}` })
    switch (verb) {
      case 'open':
      case 'go to':
      case 'navigate':
        if (!arg) return bad('say which page to open')
        steps.push({ kind: 'navigate', url: arg })
        break
      case 'click':
        if (!arg) return bad('say what to click')
        steps.push({ kind: 'click', target: arg })
        break
      case 'type': {
        const eq = arg.indexOf('=')
        if (eq <= 0) return bad('write it as "type: Field = text"')
        steps.push({ kind: 'type', target: arg.slice(0, eq).trim(), text: arg.slice(eq + 1).trim() })
        break
      }
      case 'expect':
      case 'see':
        if (!arg) return bad('say what text to expect')
        steps.push({ kind: 'expect', text: arg })
        break
      case 'wait': {
        const ms = Number(arg.replace(/ms$/i, '').trim())
        if (!Number.isFinite(ms) || ms < 0) return bad('wait takes milliseconds')
        steps.push({ kind: 'wait', ms: Math.min(ms, 10_000) })
        break
      }
      case 'screenshot':
        steps.push({ kind: 'screenshot' })
        break
      default:
        return bad(`unknown step "${verb || line}"`)
    }
    if (steps.length > MAX_STEPS) return bad(`at most ${MAX_STEPS} steps`)
  }
  return { steps, error: null }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export const detectBrowser = () => invoke<BrowserInfo>('browser_verify_detect')

export const runBrowserVerify = (request: {
  id: string
  url: string
  steps: VerifyStep[]
  timeout_ms?: number
  extra_origins?: string[]
}) => invoke<VerifyReport>('browser_verify_run', { request })

export const cancelBrowserVerify = (id: string) =>
  invoke<boolean>('browser_verify_cancel', { id })

export const PROGRESS_EVENT = 'browser-verify://progress'
