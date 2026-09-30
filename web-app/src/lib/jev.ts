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
import { isWorkProfileId, WORK_PROFILE_IDS } from '@/lib/workProfiles'

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

type RerankDecision = {
  order: string[] | null
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

function isWorkProfileCatalog(
  options: { name: string; description: string }[]
): boolean {
  if (options.length !== WORK_PROFILE_IDS.length) return false
  const names = new Set(options.map((option) => option.name))
  return WORK_PROFILE_IDS.every((id) => names.has(id))
}

/**
 * Work profiles are choices, not skills.
 *
 * The Cowork auto-profile path historically reused `jev_suggest_skill`, which
 * asks Jev "which skill should be invoked?" and therefore made abstention and
 * invalid answers common. Those then fell through to the local default
 * (`execute`), making Auto look permanently stuck on Execute.
 *
 * Reuse Jev's choice-shaped reranker instead: rank the complete profile
 * catalog against the user's request and take the first valid id. When rerank
 * is disabled/shadowed/unavailable this returns no choice and the caller keeps
 * its existing local classifier fallback; it never silently turns a Jev
 * failure into Execute here.
 */
async function jevChooseWorkProfile(
  message: string,
  profiles: { name: string; description: string }[]
): Promise<SkillDecision> {
  const decision = await invoke<RerankDecision>('jev_rerank', {
    query: message,
    candidates: profiles.map((profile) => ({
      id: profile.name,
      text: `${profile.name}: ${profile.description}`,
    })),
    k: profiles.length,
  })
  const first = decision.order?.[0]
  return {
    skill: isWorkProfileId(first) ? first : null,
    probability: null,
    fallback: decision.fallback,
    model: decision.model,
  }
}

export const jevSuggestSkill = (
  message: string,
  skills: { name: string; description: string }[]
) =>
  isWorkProfileCatalog(skills)
    ? jevChooseWorkProfile(message, skills)
    : invoke<SkillDecision>('jev_suggest_skill', { message, skills })

/**
 * The work-profile chooser Cowork hands to `chooseWorkProfile`, or undefined
 * when Jev should not be asked. Profiles are ranked through `jev_rerank`, which
 * the backend governs with the rerank mode, so that is the mode to gate on --
 * not the skill mode, which only governs `jev_suggest_skill`.
 */
export function workProfileAsker(
  rerankMode: JevMode
):
  | ((
      message: string,
      options: { name: string; description: string }[]
    ) => Promise<string | null>)
  | undefined {
  if (rerankMode !== 'on') return undefined
  return (message, options) => jevSuggestSkill(message, options).then((d) => d.skill)
}

/** Worth asking about: long enough to mean something, not already a command. */
export function shouldAskForSkill(text: string): boolean {
  const t = text.trim()
  return t.length >= 20 && !t.startsWith('/')
}
