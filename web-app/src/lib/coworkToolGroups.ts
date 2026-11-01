/**
 * Cowork's lean tool set: specialist tools held back until a run needs them.
 *
 * Every advertised tool's schema rides on every request of a run, and a plain
 * "test" used to carry about 100 of them (the browser alone is 2K to 3K
 * tokens, the host tools 3K more). The tools below are grouped by subject. A
 * run starts with the core set plus the groups its opening message, its
 * history or its sender call for, and an `enable_tools` tool lets the model
 * ask for another group mid-run.
 *
 * What this changes is only what is advertised. Approval, sandbox, plan-mode
 * and the user's own on/off switches are decided elsewhere and are untouched:
 * a held-back tool is simply absent from the request until its group is
 * offered, and a tool the user turned off is absent either way. Subagents are
 * not narrowed by this (`coworkChildTools`), so delegation loses nothing.
 *
 * The advertised set is frozen for a run (a change to the tool JSON discards
 * the prompt prefix on each of its many prefills), so groups are decided once
 * when the run starts. `enable_tools` is the one deliberate exception: it
 * appends a group after the frozen tools, costs one re-prefill, and says so.
 */
import { jsonSchema, type Tool } from 'ai'
import { SESSION_MESSAGING_TOOL_NAMES } from '@/lib/sessionMessagingTools'

export type ToolGroupId =
  | 'browser'
  | 'computer'
  | 'images'
  | 'team'
  | 'messaging'
  | 'host'
  | 'devops'
  | 'repo'
  | 'extras'

type GroupSpec = {
  /** Exact tool names. */
  tools: readonly string[]
  /** Name prefix that also belongs (the older per-action browser tools). */
  prefix?: string
  /** One line for the `enable_tools` description and the context popover. */
  subject: string
  /** An opening message or earlier user turn that mentions the subject. */
  trigger: RegExp
}

export const TOOL_GROUPS: Readonly<Record<ToolGroupId, GroupSpec>> = {
  browser: {
    tools: ['browser'],
    prefix: 'browser_',
    subject: 'drive a web page: open, read, click, type, screenshot',
    trigger:
      /\b(browser|browse|web ?pages?|websites?|sites?|urls?|https?|localhost|navigate|click|e2e|end-to-end|playwright|selenium|puppeteer|scrape|ui test)\b/i,
  },
  computer: {
    tools: ['computer', 'clipboard', 'open_path', 'notify_user'],
    subject: 'see and drive the desktop, clipboard, open a file, notify',
    trigger:
      /\b(screen|desktop|mouse|keyboard|cursor|windows?|clipboard|paste|notify|notification|remind|explorer|finder|reveal|open (the |this |that )?(file|folder|directory))\b/i,
  },
  images: {
    tools: ['image_gen', 'image_edit', 'image_view', 'ocr'],
    subject: 'make, edit or look at pictures; OCR',
    trigger:
      /\b(images?|pictures?|photos?|png|jpe?g|webp|gif|svg|logo|icon|illustration|draw|ocr|wallpaper)\b/i,
  },
  team: {
    tools: ['team'],
    subject: 'run several subagents as a declared set with dependencies',
    trigger:
      /\b(teams?|agents?|subagents?|swarm|parallel|delegat\w*|crew|fan.?out|reviewers?)\b/i,
  },
  messaging: {
    tools: [...SESSION_MESSAGING_TOOL_NAMES],
    subject: 'message, list, wait on or stop other sessions',
    trigger:
      /\b(messages?|messaging|sessions?|other (chats?|conversations?)|conversations?|repl(y|ies)|inbox|tell|send)\b/i,
  },
  host: {
    tools: [
      'host_query',
      'host_action',
      'host_package',
      'host_powershell',
      'windows_events',
    ],
    subject: 'read host facts, kill/restart, install packages, PowerShell, event log',
    trigger:
      /\b(process(es)?|services?|kill|restart|terminate|install|uninstall|upgrade|winget|package|powershell|event (log|viewer)|crash|bsod|disk|cpu|ram|registry|firewall|network|system|host)\b/i,
  },
  devops: {
    tools: ['host_build', 'docker', 'local_http', 'host_wsl', 'host_ssh'],
    subject: 'Gradle/Maven/.NET builds, Docker, local HTTP, WSL, SSH',
    trigger:
      /\b(docker|containers?|compose|gradle|maven|mvn|dotnet|\.net|msbuild|build|ssh|wsl|ubuntu|linux|localhost|127\.0\.0\.1|curl|http|api|endpoint|port|server)\b/i,
  },
  repo: {
    tools: ['git_inspect', 'git_clone'],
    subject: 'inspect or clone a git repository',
    trigger:
      /\b(git|github|repos?|repository|branch(es)?|commits?|diff|clone|pull request|prs?|merge|rebase)\b/i,
  },
  extras: {
    tools: ['screenshot', 'open_in_browser', 'list_plugins', 'memory_propose', 'skill_write'],
    subject: 'render a page, open in browser, list plugins, propose memory, write a skill',
    trigger: /\b(screenshots?|preview|plugins?|propose|skills?|remember|memory)\b/i,
  },
}

export const ENABLE_TOOLS_NAME = 'enable_tools'

const GROUP_IDS = Object.keys(TOOL_GROUPS) as ToolGroupId[]

const byName = new Map<string, ToolGroupId>()
for (const id of GROUP_IDS) for (const name of TOOL_GROUPS[id].tools) byName.set(name, id)

/** The group a tool belongs to, or undefined for a core tool. */
export function groupOf(name: string): ToolGroupId | undefined {
  const exact = byName.get(name)
  if (exact) return exact
  for (const id of GROUP_IDS) {
    const prefix = TOOL_GROUPS[id].prefix
    if (prefix && name.startsWith(prefix)) return id
  }
  return undefined
}

type PartLike = { type?: string; text?: string; toolName?: string }
type MessageLike = { role?: string; parts?: PartLike[] }

function calledToolNames(m: MessageLike): string[] {
  const out: string[] = []
  for (const p of m.parts ?? []) {
    if (p.type === 'dynamic-tool' && p.toolName) out.push(p.toolName)
    else if (typeof p.type === 'string' && p.type.startsWith('tool-')) out.push(p.type.slice(5))
  }
  return out
}

export type OfferInput = {
  /** What the user typed to start this run (empty for a resume). */
  text: string
  /** The session's earlier messages: sticky, so a group offered once stays. */
  history?: readonly MessageLike[]
  /** The run was started by another session's message. */
  fromSession?: boolean
  /** Text of the skills this run activated: a skill that names a subject offers its tools. */
  skillText?: string
}

/** Groups an earlier, successful `enable_tools` call opened in this session. */
function enabledGroups(history: readonly MessageLike[]): Set<ToolGroupId | undefined> {
  const out = new Set<ToolGroupId | undefined>()
  for (const m of history) {
    for (const p of (m.parts ?? []) as (PartLike & {
      state?: string
      input?: { groups?: unknown }
      output?: unknown
    })[]) {
      const isEnable =
        p.type === `tool-${ENABLE_TOOLS_NAME}` ||
        (p.type === 'dynamic-tool' && p.toolName === ENABLE_TOOLS_NAME)
      if (!isEnable || p.state !== 'output-available') continue
      if (typeof p.output === 'string' && p.output.startsWith('ERROR')) continue
      const groups = p.input?.groups
      if (!Array.isArray(groups)) continue
      for (const g of groups) if (typeof g === 'string' && g in TOOL_GROUPS) out.add(g as ToolGroupId)
    }
  }
  return out
}

/**
 * The groups this run starts with.
 *
 * Offered when the opening message or an earlier user turn mentions the
 * subject, when the session already called one of the group's tools or opened
 * it with `enable_tools` (so the tool list does not flip between turns and the
 * cached prefix survives), when an activated skill's text names it, or, for
 * messaging, when another session started the run.
 */
export function groupsToOffer(input: OfferInput): ToolGroupId[] {
  const history = input.history ?? []
  const userText = [
    input.text,
    ...history
      .filter((m) => m.role === 'user')
      .flatMap((m) => (m.parts ?? []).map((p) => (p.type === 'text' ? (p.text ?? '') : ''))),
    input.skillText ?? '',
  ].join('\n')
  const used = new Set([
    ...history.flatMap(calledToolNames).map((n) => groupOf(n)),
    ...enabledGroups(history),
  ])
  // A request that names a tool outright ("run the tests with host_build")
  // gets its group (RQA-006): `\bbuild\b` does not match inside `host_build`,
  // so the model was told the tool did not exist.
  const words = new Set(userText.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
  return GROUP_IDS.filter(
    (id) =>
      used.has(id) ||
      TOOL_GROUPS[id].trigger.test(userText) ||
      TOOL_GROUPS[id].tools.some((name) => words.has(name)) ||
      (id === 'messaging' && input.fromSession === true)
  )
}

export type SplitTools<T> = {
  /** What the run advertises: the core set, offered groups, and `enable_tools`. */
  lean: Record<string, T>
  /** What is held back, by tool name. */
  held: Record<string, T>
  /** Held groups that have at least one tool present. */
  heldGroups: ToolGroupId[]
}

/**
 * Split a built tool set into what a run advertises and what it holds back.
 * `offer` undefined means lean is off: everything is advertised.
 */
export function splitToolGroups<T>(
  tools: Record<string, T>,
  offer: ReadonlySet<ToolGroupId> | undefined
): SplitTools<T> {
  if (!offer) return { lean: tools, held: {}, heldGroups: [] }
  const lean: Record<string, T> = {}
  const held: Record<string, T> = {}
  const heldGroups = new Set<ToolGroupId>()
  for (const [name, tool] of Object.entries(tools)) {
    const group = groupOf(name)
    if (group && !offer.has(group)) {
      held[name] = tool
      heldGroups.add(group)
    } else {
      lean[name] = tool
    }
  }
  return { lean, held, heldGroups: GROUP_IDS.filter((id) => heldGroups.has(id)) }
}

/** The set without `enable_tools`. */
export function withoutEnable<T>(tools: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(tools).filter(([n]) => n !== ENABLE_TOOLS_NAME))
}

/** The signature part: groups offered change the advertised JSON. */
export function offerSignature(offer: ReadonlySet<ToolGroupId> | undefined): string {
  return offer ? `lean:${[...offer].sort().join(',')}` : 'full'
}

/**
 * The one tool that reaches a held-back group. Its schema lists only the
 * groups still held, so it shrinks to nothing worth carrying as they open.
 */
export function enableToolsTool(heldGroups: readonly ToolGroupId[]): Tool {
  const lines = heldGroups.map((id) => `${id}: ${TOOL_GROUPS[id].subject}`)
  return {
    description:
      'Some tools are not loaded to keep requests small. Call this with the groups you need, ' +
      'then use their tools from your next step. Loading one costs a one-time re-read of the ' +
      'conversation, so ask for everything you need at once and only when you need it. ' +
      'Groups: ' +
      lines.join('; ') +
      '.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', enum: [...heldGroups] },
        },
      },
      required: ['groups'],
      additionalProperties: false,
    }),
  } as Tool
}

/** The groups an `enable_tools` call names, or an error string for the model. */
export function parseEnableRequest(
  input: unknown,
  heldGroups: readonly ToolGroupId[],
  alreadyOpen: ReadonlySet<ToolGroupId>,
  /** Groups the run started with (no tools held back for them). */
  advertised?: ReadonlySet<ToolGroupId>
): { groups: ToolGroupId[] } | string {
  const raw = (input as { groups?: unknown } | null)?.groups
  if (!Array.isArray(raw) || raw.length === 0) {
    return '`enable_tools` needs `groups`, a non-empty list of group names.'
  }
  const groups: ToolGroupId[] = []
  for (const g of raw) {
    if (typeof g !== 'string' || !(g in TOOL_GROUPS)) {
      return `Unknown group '${String(g)}'. Choose from: ${heldGroups.join(', ') || 'none left'}.`
    }
    const id = g as ToolGroupId
    if (!heldGroups.includes(id) && !alreadyOpen.has(id)) {
      if (advertised?.has(id)) {
        return `Group '${id}' is already available: use its tools directly, there is nothing to load.`
      }
      return `Group '${id}' has no tools in this run (off in Settings, or not allowed in this mode).`
    }
    if (!groups.includes(id)) groups.push(id)
  }
  return { groups }
}
