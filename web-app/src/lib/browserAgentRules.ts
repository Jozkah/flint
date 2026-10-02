/** The assistant browser's saved site rules, kept by the backend. */
import { invoke } from '@tauri-apps/api/core'

export type BrowserRule = {
  /** `example.com` (that site) or `*.example.com` (its subdomains). */
  pattern: string
  verdict: 'allow' | 'deny'
  /** Also lets this host be a local / private-network address. */
  private_ok: boolean
  added_at: number
}

export const listBrowserRules = (): Promise<BrowserRule[]> =>
  invoke<BrowserRule[]>('browser_agent_rules')

export const setBrowserRule = (
  pattern: string,
  verdict: BrowserRule['verdict'],
  privateOk = false
): Promise<BrowserRule> =>
  invoke<BrowserRule>('browser_agent_rule_set', {
    pattern,
    verdict,
    privateOk,
  })

export const removeBrowserRule = (pattern: string): Promise<boolean> =>
  invoke<boolean>('browser_agent_rule_remove', { pattern })

/** An approval that is not saved: this session, or this visit. */
export type BrowserGrant = {
  pattern: string
  scope: 'session' | 'once'
  age_secs: number
}

export const listBrowserGrants = (): Promise<BrowserGrant[]> =>
  invoke<BrowserGrant[]>('browser_agent_grants')

export const clearBrowserGrants = (): Promise<void> =>
  invoke<void>('browser_agent_clear_grants')
