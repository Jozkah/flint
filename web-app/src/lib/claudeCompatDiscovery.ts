import {
  MAX_COMPAT_BYTES,
  type AgentProbe,
  type CompatProbes,
  type InertProbe,
  type InstructionProbe,
  type McpProbe,
  type SkillProbe,
} from '@/lib/claudeCompat'

/**
 * Finding Claude configuration in an attached repository.
 *
 * Reads go through the same root-contained project reader the code panel uses,
 * so containment is enforced in Rust rather than re-implemented here. This
 * module's job is only to know *where to look* and to turn what comes back
 * into probes; every judgement about whether a component may be used belongs
 * to the resolver.
 *
 * Nothing here executes anything. A discovered command, hook or plugin is a
 * filename and a path — it is inventoried and never run.
 */

/** The two reads discovery needs, injected so the walk itself can be tested. */
export type CompatIO = {
  /** One directory level, relative to the repository root. */
  list: (rel: string) => Promise<{ name: string; relPath: string; isDir: boolean }[]>
  /** One text file, relative to the repository root. */
  read: (
    rel: string
  ) => Promise<{ content: string; oversized: boolean; binary: boolean } | null>
}

export const CLAUDE_DIR = '.claude'
export const CLAUDE_INSTRUCTIONS = 'CLAUDE.md'
export const CLAUDE_MCP_FILE = '.mcp.json'

/**
 * Fields Jan has no faithful equivalent for.
 *
 * Reported rather than translated. A `permission-mode` mapped onto the nearest
 * Cowork run mode would be a guess about authority, and a guess about
 * authority presented as a setting is worse than saying nothing was applied.
 */
const UNSUPPORTED_AGENT_FIELDS = [
  'model',
  'permission-mode',
  'permissionMode',
  'hooks',
  'mcp_servers',
  'mcpServers',
]

/** Absent is the ordinary case, not a failure. */
const isMissing = (message: string): boolean =>
  /not found|no such file|ENOENT/i.test(message)

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

/**
 * Parse the leading `---` frontmatter block.
 *
 * Deliberately small: keys and scalar or inline-list values, which is all the
 * supported subset needs. A document this cannot parse is reported malformed
 * rather than half-understood — a skill whose `name` was silently dropped
 * would be activated under the wrong identity.
 */
export function parseFrontmatter(text: string): {
  data: Record<string, unknown> | null
  body: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: null, body: text }

  const data: Record<string, unknown> = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const raw = line.slice(at + 1).trim()
    if (!key) continue
    if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = raw
        .slice(1, -1)
        .split(',')
        .map((one) => one.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    } else {
      data[key] = raw.replace(/^['"]|['"]$/g, '')
    }
  }
  return { data, body: text.slice(match[0].length) }
}

/** A frontmatter value read as a list, however it was written. */
const asList = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((one) => one.trim())
      .filter(Boolean)
  }
  return undefined
}

/** Paths a skill's body refers to, so containment can be checked on them. */
export function referencedResources(body: string): string[] {
  const found = new Set<string>()
  // Markdown links and bare relative paths in backticks: the two ways a skill
  // actually points at a file it ships with.
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) found.add(m[1])
  for (const m of body.matchAll(/`([^`\n]*\/[^`\n]*)`/g)) found.add(m[1])
  return [...found].filter(
    (one) => !/^[a-z]+:\/\//i.test(one) && !one.startsWith('#')
  )
}

async function readInstructions(
  io: CompatIO,
  root: string
): Promise<InstructionProbe[]> {
  const path = `${root}/${CLAUDE_INSTRUCTIONS}`
  try {
    const file = await io.read(CLAUDE_INSTRUCTIONS)
    if (!file) return [{ name: CLAUDE_INSTRUCTIONS, path }]
    if (file.binary) {
      return [{ name: CLAUDE_INSTRUCTIONS, path, error: 'not text' }]
    }
    if (file.oversized) {
      // Given back at the limit so the resolver reaches the same verdict it
      // would from the bytes themselves.
      return [
        {
          name: CLAUDE_INSTRUCTIONS,
          path,
          content: 'x'.repeat(MAX_COMPAT_BYTES + 1),
        },
      ]
    }
    return [{ name: CLAUDE_INSTRUCTIONS, path, content: file.content }]
  } catch (e) {
    const message = messageOf(e)
    return isMissing(message)
      ? [{ name: CLAUDE_INSTRUCTIONS, path }]
      : [{ name: CLAUDE_INSTRUCTIONS, path, error: message }]
  }
}

async function readSkills(io: CompatIO, root: string): Promise<SkillProbe[]> {
  const base = `${CLAUDE_DIR}/skills`
  let dirs: { name: string; relPath: string; isDir: boolean }[]
  try {
    dirs = await io.list(base)
  } catch {
    return []
  }

  const probes: SkillProbe[] = []
  for (const entry of dirs.filter((one) => one.isDir)) {
    const dir = `${root}/${entry.relPath}`
    const rel = `${entry.relPath}/SKILL.md`
    try {
      const file = await io.read(rel)
      if (!file || file.binary || file.oversized) {
        probes.push({
          name: entry.name,
          dir,
          source: 'project',
          error: file ? 'not readable text' : 'no SKILL.md',
        })
        continue
      }
      const { data, body } = parseFrontmatter(file.content)
      probes.push({
        name: typeof data?.name === 'string' ? data.name : entry.name,
        dir,
        source: 'project',
        frontmatter: data,
        content: body,
        // Resolved against the skill's own directory by the classifier, which
        // is what stops an "asset" pointing at the repository next door.
        resources: referencedResources(body),
      })
    } catch (e) {
      const message = messageOf(e)
      probes.push({
        name: entry.name,
        dir,
        source: 'project',
        ...(isMissing(message) ? { error: 'no SKILL.md' } : { error: message }),
      })
    }
  }
  return probes
}

async function readAgents(io: CompatIO, root: string): Promise<AgentProbe[]> {
  const base = `${CLAUDE_DIR}/agents`
  let files: { name: string; relPath: string; isDir: boolean }[]
  try {
    files = await io.list(base)
  } catch {
    return []
  }

  const probes: AgentProbe[] = []
  for (const entry of files.filter(
    (one) => !one.isDir && one.name.endsWith('.md')
  )) {
    const path = `${root}/${entry.relPath}`
    const name = entry.name.replace(/\.md$/, '')
    try {
      const file = await io.read(entry.relPath)
      if (!file || file.binary || file.oversized) {
        probes.push({ name, path, error: 'not readable text' })
        continue
      }
      const { data, body } = parseFrontmatter(file.content)
      probes.push({
        name: typeof data?.name === 'string' ? data.name : name,
        path,
        description:
          typeof data?.description === 'string' ? data.description : null,
        tools: asList(data?.tools),
        content: body,
        unsupportedFields: UNSUPPORTED_AGENT_FIELDS.filter(
          (field) => data && field in data
        ),
      })
    } catch (e) {
      probes.push({ name, path, error: messageOf(e) })
    }
  }
  return probes
}

/**
 * Read `.mcp.json` into probes.
 *
 * Values of environment variables are dropped here, at the boundary: only the
 * names travel on. Nothing downstream can leak a secret it was never given.
 */
export function parseMcpConfig(
  text: string,
  path: string
): McpProbe[] | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { error: `invalid JSON: ${messageOf(e)}` }
  }
  const servers = (parsed as { mcpServers?: Record<string, unknown> })
    ?.mcpServers
  if (!servers || typeof servers !== 'object') {
    return { error: 'no mcpServers object' }
  }

  return Object.entries(servers).map(([name, raw]) => {
    const one = (raw ?? {}) as Record<string, unknown>
    const env = one.env
    return {
      name,
      source: 'project' as const,
      path,
      transport:
        typeof one.type === 'string'
          ? one.type
          : typeof one.command === 'string'
            ? 'stdio'
            : null,
      command: typeof one.command === 'string' ? one.command : null,
      args: Array.isArray(one.args) ? one.args.map(String) : [],
      url: typeof one.url === 'string' ? one.url : null,
      envNames:
        env && typeof env === 'object' ? Object.keys(env as object).sort() : [],
      cwd: typeof one.cwd === 'string' ? one.cwd : null,
    }
  })
}

async function readMcp(io: CompatIO, root: string): Promise<McpProbe[]> {
  const path = `${root}/${CLAUDE_MCP_FILE}`
  try {
    const file = await io.read(CLAUDE_MCP_FILE)
    if (!file || file.binary) return []
    const parsed = parseMcpConfig(file.content, path)
    if ('error' in parsed) {
      return [{ name: CLAUDE_MCP_FILE, source: 'project', path, error: parsed.error }]
    }
    return parsed
  } catch (e) {
    const message = messageOf(e)
    return isMissing(message)
      ? []
      : [{ name: CLAUDE_MCP_FILE, source: 'project', path, error: message }]
  }
}

/** Directories inventoried and never executed. */
const INERT_DIRS: { rel: string; type: InertProbe['type'] }[] = [
  { rel: `${CLAUDE_DIR}/commands`, type: 'command' },
  { rel: `${CLAUDE_DIR}/hooks`, type: 'hook' },
  { rel: `${CLAUDE_DIR}/plugins`, type: 'plugin' },
]

async function readInert(io: CompatIO, root: string): Promise<InertProbe[]> {
  const probes: InertProbe[] = []
  for (const { rel, type } of INERT_DIRS) {
    let entries: { name: string; relPath: string; isDir: boolean }[]
    try {
      entries = await io.list(rel)
    } catch {
      continue
    }
    for (const entry of entries) {
      probes.push({
        name: entry.name.replace(/\.(md|json|sh|js|ts)$/, ''),
        type,
        path: `${root}/${entry.relPath}`,
        source: type === 'plugin' ? 'plugin' : 'project',
      })
    }
  }
  return probes
}

/**
 * Everything Jan can find in one repository.
 *
 * A missing directory is silence, not an error: most repositories have none of
 * this, and a run should not be told about the absence of a feature nobody
 * asked for.
 */
export async function discoverCompatibility(
  io: CompatIO,
  root: string
): Promise<CompatProbes> {
  const [instructions, skills, agents, mcp, inert] = await Promise.all([
    readInstructions(io, root),
    readSkills(io, root),
    readAgents(io, root),
    readMcp(io, root),
    readInert(io, root),
  ])
  return { instructions, skills, agents, mcp, inert }
}
