/**
 * Slash commands for every composer (Home chat, Cowork, Rooms).
 *
 * Pure parsing and expansion. The catalog comes from the backend
 * (`agent_slash_catalog`: plugin commands with their template bodies, and
 * user-invocable skills, already filtered by the per-surface enablement
 * matrix); surfaces add their own built-ins. Commands follow Claude Code's
 * format: a markdown body with optional frontmatter (`description`,
 * `argument-hint`, `allowed-tools`, `model`) and `$ARGUMENTS` / `$1`..`$9`
 * placeholders.
 *
 * Only a typed `/token` that names a known entry is a command. Anything else
 * (`/usr/bin/env`, `/nope`) is sent exactly as typed.
 */

/** A row of `agent_slash_catalog` (mirrors `SlashEntry` in `slash.rs`). */
export interface SlashCatalogEntry {
  kind: 'command' | 'skill'
  name: string
  plugin?: string
  description: string
  scope: 'project' | 'global'
  argumentHint?: string
  model?: string
  allowedTools?: string[]
  hints?: string[]
  /** Command template, frontmatter stripped. Absent for skills. */
  body?: string
}

/** A command a surface handles itself (`/new`, `/help`). */
export interface SlashBuiltin {
  name: string
  description: string
  argumentHint?: string
  run: (args: string) => void | Promise<void>
}

export type SlashSource = 'plugin' | 'skill' | 'builtin'

/** One row of the `/` menu. */
export interface SlashItem {
  /** Stable key: the qualified trigger. */
  id: string
  /** What the menu inserts and shows: bare when unambiguous, else qualified. */
  trigger: string
  /** Every name that resolves to this item (qualified and, if unique, bare). */
  aliases: string[]
  kind: 'command' | 'skill' | 'builtin'
  source: SlashSource
  scope?: 'project' | 'global'
  plugin?: string
  description: string
  argumentHint?: string
  entry?: SlashCatalogEntry
  builtin?: SlashBuiltin
}

const qualified = (e: SlashCatalogEntry) =>
  e.plugin ? `${e.plugin}:${e.name}` : e.name

/**
 * Menu rows for a catalog plus a surface's built-ins.
 *
 * Every plugin entry answers to `<plugin>:<name>`. The bare `<name>` is added
 * only when exactly one entry has that plain name and no built-in or
 * standalone skill already owns it, like Claude Code's plugin commands.
 */
export function buildSlashItems(
  entries: SlashCatalogEntry[],
  builtins: SlashBuiltin[] = []
): SlashItem[] {
  const plainCount = new Map<string, number>()
  for (const e of entries) {
    plainCount.set(e.name, (plainCount.get(e.name) ?? 0) + 1)
  }
  const builtinNames = new Set(builtins.map((b) => b.name))
  const items: SlashItem[] = builtins.map((b) => ({
    id: `builtin:${b.name}`,
    trigger: b.name,
    aliases: [b.name],
    kind: 'builtin',
    source: 'builtin',
    description: b.description,
    argumentHint: b.argumentHint,
    builtin: b,
  }))
  const seen = new Set<string>()
  for (const e of entries) {
    const full = qualified(e)
    const id = `${e.kind}:${full}`
    if (seen.has(id)) continue
    seen.add(id)
    const bareFree =
      plainCount.get(e.name) === 1 && !builtinNames.has(e.name)
    const aliases = e.plugin ? [full] : []
    if (bareFree || !e.plugin) aliases.push(e.name)
    // A standalone skill shadowed by a built-in keeps no name at all.
    if (!e.plugin && builtinNames.has(e.name)) continue
    items.push({
      id,
      trigger: bareFree ? e.name : full,
      aliases,
      kind: e.kind,
      source: e.kind === 'command' ? 'plugin' : 'skill',
      scope: e.scope,
      plugin: e.plugin,
      description: e.description,
      argumentHint: e.argumentHint ?? hintFromPlaceholders(e.hints),
      entry: e,
    })
  }
  return items
}

function hintFromPlaceholders(hints?: string[]): string | undefined {
  if (!hints?.length) return undefined
  return hints.map((h) => (h === '$ARGUMENTS' ? '[arguments]' : `<${h.slice(1)}>`)).join(' ')
}

/** A command name: letters, digits, `_ . : -`. No `/`, so paths never match. */
const NAME = /^[A-Za-z0-9][\w.:-]*$/

/**
 * Split a draft into `/token` and its arguments. Null when the draft is not
 * shaped like a command at all: no leading slash, a token with a path
 * separator (`/usr/bin`), or nothing after the slash.
 */
export function parseSlashInput(
  text: string
): { token: string; args: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trimStart())
  if (!m || !NAME.test(m[1])) return null
  return { token: m[1], args: (m[2] ?? '').trim() }
}

/** The item a draft invokes, or null (plain text, sent as typed). */
export function resolveSlash(
  text: string,
  items: SlashItem[]
): { item: SlashItem; args: string } | null {
  const parsed = parseSlashInput(text)
  if (!parsed) return null
  const item = items.find((i) => i.aliases.includes(parsed.token))
  return item ? { item, args: parsed.args } : null
}

/**
 * The query the menu filters by while the first token is being typed, or
 * null when the menu should not show (no leading slash, or the user already
 * moved on to arguments).
 */
export function slashQuery(text: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(text)
  return m ? m[1] : null
}

/** Rank items for a query: prefix of a name first, then substring anywhere. */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.toLowerCase()
  if (!q) return items
  const score = (i: SlashItem): number => {
    const names = [i.trigger, ...i.aliases].map((n) => n.toLowerCase())
    if (names.some((n) => n === q)) return 0
    if (names.some((n) => n.startsWith(q))) return 1
    if (names.some((n) => n.split(':').pop()!.startsWith(q))) return 2
    if (names.some((n) => n.includes(q))) return 3
    if (i.description.toLowerCase().includes(q)) return 4
    return -1
  }
  return items
    .map((item, index) => ({ item, index, s: score(item) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => a.s - b.s || a.index - b.index)
    .map((r) => r.item)
}

/**
 * Substitute `$ARGUMENTS` (the whole argument string) and `$1`..`$9`
 * (whitespace-split words; missing ones become empty). `$10` and
 * `$ARGUMENTATION` stay literal. Same rules as `plugin_commands::substitute`.
 */
export function substituteArguments(body: string, args: string): string {
  const words = args.split(/\s+/).filter(Boolean)
  return body.replace(/\$(ARGUMENTS(?![A-Za-z0-9])|[1-9](?!\d))/g, (_m, token: string) =>
    token.startsWith('ARGUMENTS') ? args : (words[Number(token) - 1] ?? '')
  )
}

const usesPlaceholders = (body: string) =>
  /\$(ARGUMENTS(?![A-Za-z0-9])|[1-9](?!\d))/.test(body)

/** What was invoked, carried at the top of the message so the UI can show it compactly. */
export interface SlashInvocation {
  kind: 'command' | 'skill'
  name: string
  args: string
}

const MARKER = /^<!-- flint:slash (\{.*?\}) -->\n?/

/** The first line of an expanded message: an HTML comment the UI reads back. */
export function slashMarker(inv: SlashInvocation): string {
  // `--` cannot appear inside an HTML comment; JSON reads `-` back as `-`.
  const json = JSON.stringify(inv).replace(/-/g, '\\u002d')
  return `<!-- flint:slash ${json} -->\n`
}

/** Read the invocation back from a message; null for an ordinary message. */
export function parseSlashMarker(
  text: string
): { invocation: SlashInvocation; body: string } | null {
  const m = MARKER.exec(text)
  if (!m) return null
  try {
    const inv = JSON.parse(m[1]) as SlashInvocation
    if (
      (inv.kind !== 'command' && inv.kind !== 'skill') ||
      typeof inv.name !== 'string' ||
      typeof inv.args !== 'string'
    ) {
      return null
    }
    return { invocation: inv, body: text.slice(m[0].length) }
  } catch {
    return null
  }
}

/** How a typed `/command args` reads in the transcript. */
export const slashDisplay = (inv: SlashInvocation) =>
  `/${inv.name}${inv.args ? ` ${inv.args}` : ''}`

/**
 * The message the model receives for a plugin command: the invocation header
 * the agent uses for commands, then the body with arguments substituted. A
 * body with no placeholders gets the arguments appended, as Claude Code does,
 * so they are never silently dropped. `allowed-tools` is passed along as an
 * instruction; `model` is shown in the menu only.
 */
export function expandCommand(entry: SlashCatalogEntry, args: string): string {
  const name = qualified(entry)
  const body = entry.body ?? ''
  let text = substituteArguments(body, args).trim()
  if (args && !usesPlaceholders(body)) {
    text = `${text}\n\nARGUMENTS: ${args}`
  }
  const tools = entry.allowedTools?.length
    ? `\n\n[This command may use only these tools: ${entry.allowedTools.join(', ')}]`
    : ''
  return (
    slashMarker({ kind: 'command', name, args }) +
    `[IMPORTANT: You have invoked the "${name}" command - follow its instructions. The full command content is loaded below.]\n\n` +
    text +
    tools
  )
}

/** Wrap a skill invocation message from the backend with the marker. */
export function markSkillMessage(qualifiedName: string, args: string, message: string): string {
  return slashMarker({ kind: 'skill', name: qualifiedName, args }) + message
}

/** The qualified name of a catalog item (what the backend resolves). */
export const qualifiedName = (item: SlashItem) =>
  item.entry ? qualified(item.entry) : item.trigger

/** DOM id of a `/` menu row, for `aria-activedescendant`. */
export const slashOptionId = (listId: string, index: number) =>
  `${listId}-opt-${index}`
