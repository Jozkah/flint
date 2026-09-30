import { projectScope, readSkill, storeScope } from '@/lib/skillStore'
import { useAutomationSettings } from '@/hooks/useAutomationSettings'
import { getCachedSkills, type CatalogSkill } from '@/lib/skillCatalog'
import { isAlwaysActive, isTrustedSkill } from '@/hooks/useSkillActivation'
import { useJevSettings } from '@/hooks/useJevSettings'
import { jevSuggestSkill, shouldAskForSkill } from '@/lib/jev'
import { onSkillsChanged } from '@/lib/skillEvents'

/**
 * Automatic skill activation.
 *
 * A catalogue only helps when the model decides to use it, and a small model
 * often does not. Three things make a skill apply without being asked for:
 *
 * 1. **Always active** -- the skill says `always: true`, or the user turned it
 *    on. Its instructions are in every prompt (a response style, house rules).
 * 2. **Triggered** -- the request contains one of the skill's `triggers:`
 *    phrases. Matched locally, no network.
 * 3. **Suggested by Jev** -- with skill suggestions On, Jev picks the one
 *    installed skill that fits the request, or abstains. Never for a temporary
 *    chat.
 *
 * An activated skill's body goes into the system prompt for that turn, so it is
 * followed rather than merely available. A skill activated this way grants
 * nothing: tools, folders and approvals are gated exactly as before.
 */

/** The most of a prompt one activated skill may take, in characters. */
export const ACTIVATED_SKILL_MAX_CHARS = 6_000
/** All activated skills together. */
export const ACTIVATED_TOTAL_MAX_CHARS = 14_000
/** How many skills a request may activate beyond the always-active ones. */
export const MAX_TRIGGERED_SKILLS = 3
/** How long a Jev suggestion is waited for; a slow answer never holds up a prompt. */
export const JEV_SKILL_TIMEOUT_MS = 2_500
/** Skill names a Jev suggestion is asked to choose among. */
const JEV_CANDIDATE_LIMIT = 60

export type ActivatedSkill = {
  name: string
  /** Empty for a `nudge`, which carries no instructions of its own. */
  body: string
  /** Why it is here: `always`, `trigger: <phrase>` or `jev`. */
  why: string
  /**
   * `body`: the instructions are in the prompt. `nudge`: only the name is, with
   * an instruction to `skill_read` it. A plugin's skill is a nudge unless the
   * user made it always-active: its author's trigger phrases must not put the
   * author's text into the system prompt, which is more than the model reading
   * the skill through a tool would be given.
   */
  mode: 'body' | 'nudge'
}

/** The newest user message's text and id, or null when there is none. */
export function latestUserText(
  messages: readonly { id: string; role: string; parts: readonly { type: string; text?: string }[] }[]
): { id: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const text = m.parts
      .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return { id: m.id, text }
  }
  return null
}

/** A skill's instructions without its frontmatter. */
export function stripFrontmatter(raw: string): string {
  const text = raw.replace(/^\uFEFF/, '')
  if (!/^---\r?\n/.test(text)) return text
  const rest = text.replace(/^---\r?\n/, '')
  const end = rest.search(/^---\s*$/m)
  if (end < 0) return text
  return rest.slice(end).replace(/^---\s*\r?\n?/, '').replace(/^\r?\n/, '')
}

/**
 * The first trigger phrase of `skill` that `text` contains, on word edges so
 * "pr" does not fire inside "improve". Case-insensitive.
 */
export function matchedTrigger(skill: CatalogSkill, text: string): string | null {
  const haystack = text.toLowerCase()
  for (const phrase of skill.triggers ?? []) {
    const needle = phrase.trim().toLowerCase()
    if (!needle) continue
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(haystack)) {
      return phrase
    }
  }
  return null
}

/** How long a read skill body is reused. Edits made by the app clear it at once. */
export const SKILL_BODY_TTL_MS = 10_000
const bodyCache = new Map<string, { body: string; at: number }>()

async function bodyOf(skill: CatalogSkill): Promise<string | null> {
  const key = skill.origin === 'project' && skill.folder ? `@${skill.folder}::${skill.name}` : skill.name
  const hit = bodyCache.get(key)
  if (hit && Date.now() - hit.at < SKILL_BODY_TTL_MS) return hit.body
  try {
    const scope = skill.origin === 'project' && skill.folder ? projectScope(skill.folder) : storeScope
    const body = stripFrontmatter(await readSkill(scope, skill.name)).trim()
    if (!body) return null
    bodyCache.set(key, { body, at: Date.now() })
    return body
  } catch {
    return null
  }
}

/** Forget cached bodies, after a skill was edited or the catalogue refreshed. */
export function clearSkillBodyCache(): void {
  bodyCache.clear()
}

onSkillsChanged(clearSkillBodyCache)

/**
 * The skills worth asking Jev about, most relevant first. With more skills than
 * fit in one question the old order (own skills, then plugins') cut a plugin's
 * skill off the list before Jev saw it, however well it matched. A word from the
 * message that starts like a word in the skill's name or description counts
 * ("brainstorm" finds "brainstorming"); ties keep the own-skills-first order.
 */
export function rankCandidates(text: string, candidates: CatalogSkill[]): CatalogSkill[] {
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 5)
        .map((w) => w.slice(0, Math.max(5, w.length - 3)))
    ),
  ]
  const score = (s: CatalogSkill) => {
    const hay = `${s.name} ${s.description ?? ''}`.toLowerCase()
    return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0)
  }
  return candidates
    .map((s, i) => ({ s, i, score: score(s) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(Boolean(a.s.plugin)) - Number(Boolean(b.s.plugin)) ||
        a.i - b.i
    )
    .map((x) => x.s)
}

async function jevPick(
  text: string,
  candidates: CatalogSkill[],
  signal?: AbortSignal
): Promise<string | null> {
  if (useJevSettings.getState().skillMode !== 'on' || !shouldAskForSkill(text)) return null
  const options = rankCandidates(text, candidates)
    .slice(0, JEV_CANDIDATE_LIMIT)
    .map((s) => ({ name: s.name, description: s.description ?? '' }))
  if (options.length === 0) return null
  try {
    const decision = await new Promise<Awaited<ReturnType<typeof jevSuggestSkill>>>(
      (resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'))
        const onAbort = () => reject(new Error('aborted'))
        signal?.addEventListener('abort', onAbort, { once: true })
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          reject(new Error('timeout'))
        }, JEV_SKILL_TIMEOUT_MS)
        jevSuggestSkill(text, options).finally(() => clearTimeout(timer)).then(
          (v) => {
            signal?.removeEventListener('abort', onAbort)
            resolve(v)
          },
          (e) => {
            signal?.removeEventListener('abort', onAbort)
            reject(e)
          }
        )
      }
    )
    return options.some((o) => o.name === decision.skill) ? decision.skill : null
  } catch {
    // Decision support, never a reason to fail the prompt.
    return null
  }
}

/**
 * Which skills apply to this request, with their instructions. `skills`
 * defaults to the cached catalogue. Order: always-active first, then triggered,
 * then Jev's pick; each skill once.
 */
export async function resolveSkillActivation(args: {
  text: string
  temporary?: boolean
  signal?: AbortSignal
  skills?: readonly CatalogSkill[]
  /** The attached project folder, whose own skills are considered too. */
  folder?: string | null
}): Promise<ActivatedSkill[]> {
  // The user turned automatic skills off: nothing applies on its own, though
  // the model can still read a skill it sees in the catalogue.
  if (!useAutomationSettings.getState().activateSkills) return []
  const skills = (args.skills ?? getCachedSkills(args.folder)).filter((s) => s.model_invocable !== false)
  if (skills.length === 0) return []
  const picked: { name: string; why: string }[] = []
  const seen = new Set<string>()
  const add = (name: string, why: string) => {
    if (seen.has(name)) return
    seen.add(name)
    picked.push({ name, why })
  }

  for (const s of skills) if (isAlwaysActive(s)) add(s.name, 'always')

  let triggered = 0
  for (const s of skills) {
    if (triggered >= MAX_TRIGGERED_SKILLS) break
    if (seen.has(s.name)) continue
    const phrase = matchedTrigger(s, args.text)
    if (phrase) {
      add(s.name, `trigger: ${phrase}`)
      triggered += 1
    }
  }

  if (!args.temporary && triggered < MAX_TRIGGERED_SKILLS) {
    const rest = skills.filter((s) => !seen.has(s.name) && !(s.triggers?.length))
    const name = await jevPick(args.text, rest, args.signal)
    if (name) add(name, 'jev')
  }

  const byName = new Map(skills.map((s) => [s.name, s]))
  const out: ActivatedSkill[] = []
  for (const p of picked) {
    // Only what the user vouched for, or wrote themselves, goes in as text.
    const skill = byName.get(p.name)
    if (!skill) continue
    if (p.why !== 'always' && !isTrustedSkill(skill)) {
      out.push({ name: p.name, body: '', why: p.why, mode: 'nudge' })
      continue
    }
    const body = await bodyOf(skill)
    if (body) out.push({ name: p.name, body, why: p.why, mode: 'body' })
  }
  return out
}

/**
 * The prompt text for activated skills, or `''` for none. Each body is cut at
 * [`ACTIVATED_SKILL_MAX_CHARS`] (with a pointer to `skill_read` for the rest)
 * and the whole at [`ACTIVATED_TOTAL_MAX_CHARS`].
 */
export function skillActivationBlock(active: readonly ActivatedSkill[]): string {
  if (active.length === 0) return ''
  let used = 0
  const sections: string[] = []
  const nudges: string[] = []
  for (const a of active) {
    if (a.mode === 'nudge') {
      nudges.push(`- \`${a.name}\` (${a.why === 'jev' ? 'suggested' : a.why})`)
      continue
    }
    const room = ACTIVATED_TOTAL_MAX_CHARS - used
    if (room < 400) break
    const cap = Math.min(ACTIVATED_SKILL_MAX_CHARS, room)
    const cut = a.body.length > cap
    const body = cut ? `${a.body.slice(0, cap).trimEnd()}\n...` : a.body
    used += body.length
    const label = a.why === 'always' ? 'always active' : `activated by ${a.why}`
    sections.push(
      `## ${a.name} (${label})\n\n${body}${
        cut ? `\n\n(Cut for length: call \`skill_read\` with "${a.name}" for the rest.)` : ''
      }`
    )
  }
  const parts: string[] = []
  if (sections.length > 0) {
    parts.push(
      [
        '# Active skills',
        '',
        'These skills apply to this conversation. Follow them for every reply they cover;',
        'they change how you work, not what you are allowed to do: tools, folders and',
        'approvals are unchanged.',
        '',
        sections.join('\n\n'),
      ].join('\n')
    )
  }
  if (nudges.length > 0) {
    parts.push(
      [
        '# Skills that match this request',
        '',
        'Before you do anything else, call `skill_read` with each name below and follow it:',
        ...nudges,
      ].join('\n')
    )
  }
  return parts.join('\n\n')
}
