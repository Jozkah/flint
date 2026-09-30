import {
  listSkills,
  projectScope,
  storeScope,
  type SkillMeta,
} from '@/lib/skillStore'
import { onSkillsChanged } from '@/lib/skillEvents'

/**
 * The skills the model is told about in its system prompt.
 *
 * Cowork and chat used to advertise `skill_list`/`skill_read` in the tool
 * schemas and say nothing else, so a model only used a skill when it happened
 * to think of calling `skill_list` first. The terminal UI has always put the
 * catalogue in the prompt; this gives the desktop the same, read from the same
 * places (`agent_skill_list`, plugin skills included): the global store, and
 * the attached project folder's own skills when a run has one.
 */

/** Same budget and line length as the terminal UI's catalogue (`context.rs`). */
export const SKILL_CATALOG_BUDGET_CHARS = 8_000
export const SKILL_SUMMARY_MAX_CHARS = 120

/** The wire shape carries more than the API type names (`agent_skill_list`). */
export type CatalogSkill = SkillMeta & {
  model_invocable?: boolean
  /** `always: true` in the skill's frontmatter. */
  always?: boolean
  /** `triggers:` phrases in the skill's frontmatter. */
  triggers?: string[]
  /**
   * `project` for a skill that lives in the attached folder, and which folder.
   * Absent for the global store. A project skill comes from whatever repository
   * the user opened, so it is treated like a plugin's: not trusted to write
   * itself into the system prompt.
   */
  origin?: 'project'
  folder?: string
}

type Entry = { skills: CatalogSkill[]; at: number }

/** Per attached folder; `''` is the global store alone. */
const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<void>>()

const keyOf = (folder?: string | null) => folder ?? ''

/**
 * How long a fetched list is reused. A message triggers a refresh from more
 * than one place (the chat transport's tool refresh and the activation step);
 * within this window they share one fetch instead of each asking the backend.
 */
export const SKILL_CATALOG_MAX_AGE_MS = 2_000

/**
 * The global skills plus the folder's own. A project skill shadows a global one
 * of the same name, as the tools resolve them, so a name means one skill.
 */
async function fetchCatalog(folder?: string | null): Promise<CatalogSkill[]> {
  const global = (await listSkills(storeScope)) as CatalogSkill[]
  if (!folder) return global
  let project: CatalogSkill[] = []
  try {
    project = ((await listSkills(projectScope(folder))) as CatalogSkill[]).map((s) => ({
      ...s,
      origin: 'project' as const,
      folder,
    }))
  } catch {
    // A folder without a skills directory is a folder without project skills.
  }
  const shadowed = new Set(project.map((s) => s.name))
  return [...project, ...global.filter((s) => !shadowed.has(s.name))]
}

/** Refresh the cached list the system prompt reads. Never throws. */
export function refreshSkillCatalog(folder?: string | null): Promise<void> {
  const key = keyOf(folder)
  const pending = inFlight.get(key)
  if (pending) return pending
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < SKILL_CATALOG_MAX_AGE_MS) return Promise.resolve()
  const run = (async () => {
    try {
      cache.set(key, { skills: await fetchCatalog(folder), at: Date.now() })
    } catch {
      // Keep the previous list: a prompt with no catalogue is safe, one that
      // names skills that are gone is not.
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, run)
  return run
}

/** Make the next refresh fetch again, after skills were installed or edited. */
export function invalidateSkillCatalog(): void {
  for (const entry of cache.values()) entry.at = 0
}

onSkillsChanged(invalidateSkillCatalog)

/** The cached catalogue, for the activation step. */
export function getCachedSkills(folder?: string | null): CatalogSkill[] {
  return cache.get(keyOf(folder))?.skills ?? cache.get('')?.skills ?? []
}

/** For tests: set (or clear) the global list, and forget every folder's. */
export function setCachedSkillCatalog(skills: CatalogSkill[] | null) {
  cache.clear()
  if (skills) cache.set('', { skills, at: 0 })
}

export function skillSummary(description: string): string {
  const first = (description ?? '').trim().split('\n')[0]?.trim() ?? ''
  const chars = Array.from(first)
  if (chars.length <= SKILL_SUMMARY_MAX_CHARS) return first
  return `${chars.slice(0, SKILL_SUMMARY_MAX_CHARS - 3).join('').trimEnd()}...`
}

/**
 * The `# Skills` block, or `''` when there is nothing to advertise. Skills you
 * wrote come before project and plugin skills so the budget cuts those first.
 */
export function skillCatalogBlock(
  skills?: readonly CatalogSkill[] | null,
  folder?: string | null
): string {
  const offered = (skills ?? getCachedSkills(folder)).filter((s) => s.model_invocable !== false)
  if (offered.length === 0) return ''
  const rank = (s: CatalogSkill) => (s.plugin ? 2 : s.origin === 'project' ? 1 : 0)
  const ordered = [...offered].sort((a, b) => rank(a) - rank(b))
  const lines: string[] = []
  let used = 0
  let omitted = 0
  for (const skill of ordered) {
    const summary = skillSummary(skill.description)
    const line = summary ? `- \`${skill.name}\`: ${summary}` : `- \`${skill.name}\``
    if (used + line.length + 1 > SKILL_CATALOG_BUDGET_CHARS) {
      omitted += 1
      continue
    }
    used += line.length + 1
    lines.push(line)
  }
  return [
    '# Skills',
    '',
    'These skills are installed (some ship in plugins or in the attached folder). Use them:',
    'before you start a task, check this list, and when a skill covers the task even in part,',
    'call `skill_read` with its name FIRST and follow it instead of improvising. Read every',
    "skill that applies. A skill's bundled files (templates, themes, scripts) are not in your",
    'workspace: read one with `skill_read` and its `file` argument. Never `ls` or `read` a',
    'skill folder, and never use `request_access` for one.',
    '',
    ...lines,
    ...(omitted > 0
      ? [
          '',
          `${omitted} more skill${omitted === 1 ? ' is' : 's are'} not listed here to keep the prompt small; call \`skill_list\` to see every skill.`,
        ]
      : []),
  ].join('\n')
}
