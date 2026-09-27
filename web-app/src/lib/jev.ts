/**
 * Jev (TypeSafe) decision support: the renderer's view of `core::jev`.
 *
 * Everything that talks to TypeSafe runs in the backend. The renderer never
 * sees the API key -- it can only hand one over to be stored, or clear it --
 * and whether a request is made at all is decided there, from the opt-ins
 * this app persists (`useJevSettings`). With an opt-in off, the backend
 * makes no request.
 */
import type { SlashCatalogEntry } from '@/lib/slashCommands'

export type JevMode = 'off' | 'shadow' | 'on'

export type JevFallback =
  | 'disabled'
  | 'no_key'
  | 'user_invoked_skill'
  | 'nothing_to_decide'
  | 'over_request_budget'
  | 'over_daily_budget'
  | 'timeout'
  | 'http_error'
  | 'bad_response'
  | 'abstained'
  | 'shadow'

export type JevStatus = {
  skill_mode: JevMode
  rerank_mode: JevMode
  key_configured: boolean
  model: string
  tokens_used_today: number
  daily_token_budget: number
}

export type JevReceipt = {
  at: string
  feature: 'skill' | 'rerank'
  mode: JevMode
  model: string | null
  decision: string
  latency_ms: number
  input_tokens: number
  output_tokens: number
  cost_usd: number
  fallback: JevFallback | null
  sent_chars: number
  sent_items: number
}

export type SkillDecision = {
  skill: string | null
  probability: number | null
  fallback: JevFallback | null
  model: string | null
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export const jevStatus = () => invoke<JevStatus>('jev_status')
export const jevReceipts = () => invoke<JevReceipt[]>('jev_receipts')
/** Write-only: the key is stored in the protected secret store, never read back. */
export const jevSetKey = (key: string) => invoke<void>('jev_key_set', { key })
export const jevClearKey = () => invoke<void>('jev_key_clear')

/** The skills a suggestion may name: exactly the surface's own `/` catalog. */
export function eligibleSkills(catalog: SlashCatalogEntry[]) {
  return catalog
    .filter((e) => e.kind === 'skill')
    .map((e) => ({
      name: e.plugin ? `${e.plugin}:${e.name}` : e.name,
      description: e.description ?? '',
    }))
}

export const jevSuggestSkill = (
  message: string,
  skills: { name: string; description: string }[]
) => invoke<SkillDecision>('jev_suggest_skill', { message, skills })

/** Worth asking about: long enough to mean something, not already a command. */
export function shouldAskForSkill(text: string): boolean {
  const t = text.trim()
  return t.length >= 20 && !t.startsWith('/')
}
