/**
 * The `@` menu's one ranked list: files and folders in the attached folder,
 * skills, saved agents and aliases. AH-204.
 *
 * Every entry carries the token it inserts. A file inserts its path relative
 * to the folder; the others insert a typed reference (`skill:name`,
 * `agent:name`, `alias:name`). What is inserted is the identifier, never the
 * label shown, so the reference means the same thing however it is displayed.
 *
 * Files arrive already confined: they come from the backend's listing of the
 * attached folder. Nothing here can offer a path outside it.
 */
import type { FilePickerEntry } from '@/types/path-reference'
import type { ReferenceAlias } from '@/lib/referenceAliases'
import { typedReference, type TypedReferenceKind } from '@/lib/path-references'
import { rankConversations } from '@/lib/chatMentionMenu'
import { isMentionKind, type ConversationEntry } from '@/lib/chatMentions'

export type ReferenceKind = 'file' | 'directory' | 'prompt' | TypedReferenceKind

export type ReferenceEntry = {
  kind: ReferenceKind
  /** Inserted after `@`. */
  token: string
  /** What the row is called. */
  name: string
  /** A second line: a path, a description, what an alias names. */
  detail?: string
  extension?: string
  /** Set on a chat, Cowork session or room: what the richer row shows. */
  conversation?: {
    id: string
    updated: number
    messageCount?: number
    preview?: string
    /** Tells apart two rows with one title. */
    label?: string
    live?: boolean
  }
}

export type NamedSource = { name: string; description?: string }

/** The id of option `index` in the list `listId`, for `aria-activedescendant`. */
export const optionId = (listId: string, index: number) =>
  `${listId}-option-${index}`

/** A library prompt the menu may offer. `id` is what is inserted. */
export type PromptSource = { id: string; name: string; detail?: string }

export type ReferenceSources = {
  files: FilePickerEntry[]
  skills: NamedSource[]
  agents: NamedSource[]
  aliases: ReferenceAlias[]
  /** The prompt library. Absent where there is none. */
  prompts?: PromptSource[]
  /** Chats, Cowork sessions and rooms a mention may name. */
  conversations?: ConversationEntry[]
  /** The conversation being written in: it cannot mention itself. */
  currentConversationId?: string
}

/** How many conversations the `@` menu adds as its last group. */
const CHAT_GROUP_IN_AT = 8

/** Ties go to the entry most likely meant: a name the user gave, then tools. */
const KIND_ORDER: Record<ReferenceKind, number> = {
  alias: 0,
  prompt: 1,
  skill: 2,
  agent: 3,
  directory: 4,
  file: 5,
  chat: 6,
  session: 7,
  room: 8,
}

function score(q: string, name: string, detail = ''): number {
  if (!q) return 10
  const n = name.toLowerCase()
  if (n === q) return 100
  if (n.startsWith(q)) return 80
  if (n.includes(q)) return 60
  if (detail.toLowerCase().includes(q)) return 40
  return 0
}

/**
 * Rank everything the `@` menu can offer for `query`, as one list.
 *
 * A query that starts with a kind (`skill:rev`) offers only that kind. A
 * source that failed to load is simply empty: the rest still rank, and
 * typing is never blocked on an index.
 */
export function rankReferences(
  query: string,
  sources: ReferenceSources,
  limit = 50,
  /** `#` lists conversations only; `@` (the default) lists everything. */
  trigger: '@' | '#' = '@'
): ReferenceEntry[] {
  let q = query.trim().toLowerCase()
  let only: ReferenceKind | null = null
  const prefixed = /^(skill|agent|alias|prompt|chat|session|room):(.*)$/.exec(q)
  if (prefixed) {
    only = prefixed[1] as ReferenceKind
    q = prefixed[2]
  }
  // Conversations: the `@` menu's last group, or the whole `#` menu.
  const wantsConversations = trigger === '#' || !only || isMentionKind(only)
  const conversations = wantsConversations
    ? rankConversations(q, sources.conversations ?? [], {
        excludeId: sources.currentConversationId,
        only: only && isMentionKind(only) ? only : undefined,
        limit: trigger === '#' || only ? limit : CHAT_GROUP_IN_AT,
      })
    : []
  if (trigger === '#') return conversations.slice(0, limit)
  const candidates: ReferenceEntry[] = [
    ...(sources.prompts ?? []).map(
      (prompt): ReferenceEntry => ({
        kind: 'prompt',
        token: `prompt:${prompt.id}`,
        name: prompt.name,
        detail: prompt.detail,
      })
    ),
    ...sources.aliases.map(
      (alias): ReferenceEntry => ({
        kind: 'alias',
        token: `alias:${alias.name}`,
        name: alias.name,
        detail: alias.target,
      })
    ),
    ...sources.skills.map(
      (skill): ReferenceEntry => ({
        kind: 'skill',
        token: `skill:${skill.name}`,
        name: skill.name,
        detail: skill.description,
      })
    ),
    ...sources.agents.map(
      (agent): ReferenceEntry => ({
        kind: 'agent',
        token: `agent:${agent.name}`,
        name: agent.name,
        detail: agent.description,
      })
    ),
    ...sources.files.map(
      (file): ReferenceEntry => ({
        kind: file.kind,
        token: file.path,
        name: file.name,
        detail: file.path,
        extension: file.extension,
      })
    ),
  ]
  const ranked = (
    candidates
      .filter((entry) => !only || entry.kind === only)
      // A typed token must stay a typed token: a name the pattern cannot carry
      // would insert a reference that reads back as something else.
      .filter((entry) =>
        entry.kind === 'file' || entry.kind === 'directory' || entry.kind === 'prompt'
          ? true
          : typedReference(entry.token) !== null
      )
      .map((entry) => ({ entry, s: score(q, entry.name, entry.detail) }))
      .filter(({ s }) => s > 0)
      .sort(
        (a, b) =>
          b.s - a.s ||
          KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind] ||
          a.entry.name.length - b.entry.name.length ||
          a.entry.token.localeCompare(b.entry.token)
      )
      .slice(0, Math.max(0, limit - conversations.length))
      .map(({ entry }) => entry)
  )
  return [...ranked, ...conversations]
}
