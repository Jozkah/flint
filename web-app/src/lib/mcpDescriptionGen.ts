/**
 * "About this server" descriptions written by a model.
 *
 * The pure parts (which servers to ask about, what to send, how to clean the
 * reply, when a result may be saved) live here so they can be tested without
 * a model. `generateServerDescription` is the one call that reaches a model,
 * through the hidden utility agent: no tools, nothing shown, always recorded.
 */
import type { MCPServerConfig, MCPServers } from '@/hooks/useMCPServers'
import type { MCPTool } from '@/types/completion'
import { runUtilityAgent } from './utilityAgents'
import { ModelFactory } from './model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { BACKGROUND_SLOT_ID } from '@/constants/models'

export type DescriptionScope = 'empty' | 'all'

/** Longest tool description passed on; the rest is noise for a summary. */
const MAX_TOOL_DESCRIPTION = 200
/** Tools listed before the list is cut off with a count. */
const MAX_TOOLS = 40
/** Upper bound on a saved description. */
const MAX_DESCRIPTION_LENGTH = 600

export function hasDescription(config: MCPServerConfig | undefined): boolean {
  return !!config?.description?.trim()
}

/** The server names a batch run asks about, in the order given. */
export function selectServersForGeneration(
  servers: MCPServers,
  scope: DescriptionScope
): string[] {
  return Object.entries(servers)
    .filter(([, config]) => scope === 'all' || !hasDescription(config))
    .map(([name]) => name)
}

/** `path: string, recursive?: boolean` from a JSON schema, or '' if none. */
export function summarizeInputSchema(schema: Record<string, unknown>): string {
  const props = schema?.properties
  if (!props || typeof props !== 'object') return ''
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : []
  )
  return Object.entries(props as Record<string, Record<string, unknown>>)
    .map(([key, def]) => {
      const type =
        typeof def?.type === 'string'
          ? def.type
          : Array.isArray(def?.type)
            ? (def.type as string[]).join('|')
            : 'any'
      return `${key}${required.has(key) ? '' : '?'}: ${type}`
    })
    .join(', ')
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

export function buildDescribePrompt(
  serverName: string,
  tools: Pick<MCPTool, 'name' | 'description' | 'inputSchema'>[]
): string {
  const shown = tools.slice(0, MAX_TOOLS)
  const lines = shown.map((tool) => {
    const args = summarizeInputSchema(tool.inputSchema ?? {})
    const desc = tool.description ? ` - ${clip(tool.description, MAX_TOOL_DESCRIPTION)}` : ''
    return `- ${tool.name}(${args})${desc}`
  })
  if (tools.length > shown.length) {
    lines.push(`- ...and ${tools.length - shown.length} more tools`)
  }
  return [
    'Write the "About this server" text for an MCP server in a settings page.',
    'Use 1 to 3 plain, factual sentences: what the server is for and its most notable tools.',
    'No marketing language, no markdown, no lists, no quotes. Do not invent capabilities the tools do not show.',
    'Output the text only.',
    '',
    `Server name: ${serverName}`,
    `Tools (${tools.length}):`,
    ...(lines.length ? lines : ['- (none)']),
  ].join('\n')
}

/** Strip reasoning blocks, markdown and wrapping quotes. Null if unusable. */
export function cleanDescription(raw: string): string | null {
  let text = raw
    .replace(/<(think|thinking|reasoning|analysis)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim()
  if (/<(think|thinking|reasoning|analysis)[^>]*>/i.test(text)) return null
  const lastClose = text.match(
    /<\/(?:think|thinking|reasoning|analysis)>\s*([\s\S]*)$/i
  )
  if (lastClose) text = lastClose[1]
  text = text
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim()
  if (text.length < 8) return null
  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()}...`
    : text
}

export type ReviewDecision = 'pending' | 'accepted' | 'rejected'

export type ReviewItem = {
  server: string
  /** The description when generation started; guards against overwrites. */
  before: string
  text: string
  decision: ReviewDecision
}

/**
 * The descriptions to write: accepted items only, and only where the stored
 * description is still what it was when generation began, so a description
 * changed meanwhile (or a server removed) is never clobbered.
 */
export function descriptionsToSave(
  items: ReviewItem[],
  servers: MCPServers
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of items) {
    if (item.decision !== 'accepted') continue
    const config = servers[item.server]
    if (!config) continue
    if ((config.description ?? '').trim() !== item.before.trim()) continue
    const text = item.text.trim()
    if (!text) continue
    out[item.server] = text
  }
  return out
}

/**
 * Last full tool list seen per server, so a server that is off now can still
 * be described from what it offered before. Kept in localStorage; losing it
 * only means such servers are skipped.
 */
const CACHE_KEY = 'flint.mcpToolCache.v1'

type CachedTool = Pick<MCPTool, 'name' | 'description' | 'inputSchema'>

function readCache(): Record<string, CachedTool[]> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, CachedTool[]>) : {}
  } catch {
    return {}
  }
}

export function cacheServerTools(server: string, tools: MCPTool[]): void {
  try {
    const cache = readCache()
    cache[server] = tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // A cache, nothing more.
  }
}

export function cachedServerTools(server: string): CachedTool[] | undefined {
  return readCache()[server]
}

/** Ask `providerName`/`modelId` for one server's description. Throws on failure. */
export async function generateServerDescription(
  providerName: string,
  modelId: string,
  serverName: string,
  tools: CachedTool[],
  abortSignal: AbortSignal
): Promise<string> {
  const provider = useModelProvider.getState().getProviderByName(providerName)
  if (!provider) throw new Error(`Provider not found: ${providerName}`)
  const params: Record<string, unknown> = {}
  if (providerName === 'llamacpp') {
    params.chat_template_kwargs = { enable_thinking: false }
    params.id_slot = BACKGROUND_SLOT_ID
  }
  const model = await ModelFactory.createModel(modelId, provider, params)
  const text = await runUtilityAgent({
    kind: 'describe',
    session: '',
    model,
    modelId,
    messages: [
      { role: 'user', content: buildDescribePrompt(serverName, tools) },
    ],
    maxOutputTokens: 300,
    abortSignal,
  })
  const cleaned = cleanDescription(text)
  if (!cleaned) throw new Error('The model returned no usable text.')
  return cleaned
}
