/**
 * Tools left out of a plain chat on a small context window.
 *
 * Every offered tool's schema rides on every request. On a 32K local model the
 * six default tools cost about 1K tokens before the user typed anything, and
 * these four are the ones a small model rarely needs: the plugin listing,
 * image search, and the two widget tools. Web search and fetch, MCP and the
 * agent tools stay. The setting lives in Settings > Agent tools (on by default).
 */
export const SMALL_WINDOW_TOKENS = 32_768

export const LOW_VALUE_TOOLS: ReadonlySet<string> = new Set([
  'list_plugins',
  'image_search',
  'visualize_read_me',
  'show_widget',
])

export function toolsForWindow<T>(
  tools: Record<string, T>,
  windowTokens: number,
  lean: boolean,
  /** Small-context mode is on (`lib/smallContext.ts`): the low-value tools go whatever the window. */
  small = false
): Record<string, T> {
  if (!small && (!lean || !(windowTokens > 0) || windowTokens > SMALL_WINDOW_TOKENS)) return tools
  if (!Object.keys(tools).some((name) => LOW_VALUE_TOOLS.has(name))) return tools
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !LOW_VALUE_TOOLS.has(name))
  )
}

/**
 * Specialist tools a plain chat carries only once the conversation shows a need.
 *
 * With Agent tools on, a chat offers about 45 tools and the specialist host and
 * browser ones alone are over 5K tokens on every request, including a bare
 * "test". These are offered from the turn the user (or the model, earlier in
 * the thread) first touches their subject, and stay offered after that so the
 * tool list does not flip between turns. Approval behaviour is unchanged: a
 * tool that is offered is gated exactly as before. Cowork is not affected.
 */
const SPECIALIST_TRIGGERS: Readonly<Record<string, RegExp>> = {
  computer: /\b(screen|screenshot|click|mouse|keyboard|desktop|cursor|type into)\b/i,
  browser: /\b(browser|web ?page|website|localhost|click|navigate|page|ui test|e2e)\b/i,
  docker: /\b(docker|container|compose|image build)\b/i,
  host_ssh: /\b(ssh|remote (server|host|machine)|scp)\b/i,
  host_wsl: /\b(wsl|linux subsystem|ubuntu)\b/i,
  host_package: /\b(winget|install|uninstall|upgrade|package|app update)\b/i,
  host_action: /\b(kill|stop|restart|terminate|process|service|task manager)\b/i,
  host_build: /\b(gradle|maven|mvn|dotnet|\.net|msbuild|build)\b/i,
  windows_events: /\b(event log|event viewer|crash|bsod|windows events?)\b/i,
  local_http: /\b(localhost|127\.0\.0\.1|local server|http request|curl|api endpoint|port \d+)\b/i,
  clipboard: /\b(clipboard|paste|copy (this|that|it) to)\b/i,
  open_path: /\b(open (the |this |that )?(file|folder|directory)|show in (explorer|finder)|reveal)\b/i,
  notify_user: /\b(notify|notification|remind|alert me|ping me)\b/i,
  git_inspect: /\b(git|repo|repository|branch|commit|diff|clone)\b/i,
}

export const SPECIALIST_TOOLS: ReadonlySet<string> = new Set(Object.keys(SPECIALIST_TRIGGERS))

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

/** A message past this length is likely to carry a need the English triggers miss. */
const LONG_MESSAGE_CHARS = 600

/**
 * The triggers above are English words. A prompt in another language (CJK,
 * Czech, Cyrillic...) would never match them and chat has no way to load a
 * stripped tool, so such a prompt, or a long one, gets the full specialist set.
 */
export function triggersCannotJudge(text: string): boolean {
  if (text.length > LONG_MESSAGE_CHARS) return true
  for (const ch of text) {
    if (ch.charCodeAt(0) > 127 && /\p{L}/u.test(ch)) return true
  }
  return false
}

/**
 * Chat's tools without the specialist ones nothing in the conversation has
 * asked for. `lean` off, or no specialist tool in the set, returns it as is.
 * `isExternal` names tools that are not built-ins (MCP tools): one that shares
 * a specialist's name is never filtered.
 */
export function toolsForConversation<T>(
  tools: Record<string, T>,
  messages: readonly MessageLike[],
  lean: boolean,
  isExternal: (name: string) => boolean = () => false
): Record<string, T> {
  const gated = (n: string) => SPECIALIST_TOOLS.has(n) && !isExternal(n)
  if (!lean || !Object.keys(tools).some(gated)) return tools
  const userText = messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => (m.parts ?? []).map((p) => (p.type === 'text' ? (p.text ?? '') : '')))
    .join('\n')
  if (triggersCannotJudge(userText)) return tools
  const used = new Set(messages.flatMap(calledToolNames))
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name]) => !gated(name) || used.has(name) || SPECIALIST_TRIGGERS[name]!.test(userText)
    )
  )
}
