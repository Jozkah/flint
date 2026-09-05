import { resolveInRoot } from '@/lib/coworkPreview'
import { sameBinding, type Binding } from '@/lib/coworkReadiness'

/**
 * Claude Code project configuration, read on Jan's terms.
 *
 * A repository can carry configuration written for another harness: a
 * `CLAUDE.md`, skill packages, agent definitions, MCP servers. Making a user
 * rewrite all of it to try Jan is a poor trade, so Jan reads the parts it can
 * reproduce faithfully — and says plainly which parts it cannot.
 *
 * Three rules shape everything here.
 *
 * **Detection is not activation.** Finding a file says only that it exists.
 * Compatibility is switched on per repository, by the user, and switching it
 * on grants nothing: not write access, not a different access mode, not a
 * running process.
 *
 * **Configuration is never authority.** Every component here is content the
 * repository supplied, which means it is content an attacker who can open a
 * pull request supplied. An imported agent inherits its parent's authority and
 * can only ever narrow it. Instructions cannot select a repository, grant a
 * tool, or start a server, however they are phrased.
 *
 * **What Jan cannot reproduce, it refuses rather than approximates.** A field
 * translated on a guess is worse than one reported unsupported: the user
 * believes their configuration is in force when it is not.
 */

/** What kind of thing was found. */
export type CompatComponentType =
  | 'instructions'
  | 'skill'
  | 'agent'
  | 'mcp'
  /** Detected for the inventory only; never executed. */
  | 'command'
  | 'hook'
  | 'plugin'

/**
 * What is actually happening with a component.
 *
 * Deliberately more states than "works"/"doesn't". The difference between a
 * skill that is malformed, one that is switched off, and one whose resources
 * escape the repository is the difference between a bug to fix, a checkbox to
 * tick, and a repository to distrust.
 */
export type CompatState =
  /** In force for this run. */
  | 'active'
  /** Usable, and not switched on. */
  | 'available'
  /** Switched off by the user. */
  | 'disabled'
  /** Present but not parseable. */
  | 'malformed'
  | 'unreadable'
  | 'oversized'
  /** Another component already claimed this identity. */
  | 'duplicate'
  /** A path in it resolved outside the repository. */
  | 'path-escape'
  /** Jan cannot reproduce this faithfully, so it does not pretend to. */
  | 'unsupported'
  /** Names a tool, skill or server that is not there. */
  | 'missing-dependency'
  /** Waiting for the user to allow it. */
  | 'consent-required'
  /** Tried to start, and did not. */
  | 'init-failed'
  /**
   * Would run as an unconfined local process on this platform.
   *
   * Not a degraded "on": a local MCP server inherits whatever the launcher
   * gives it, and Jan's launcher gives it the user's whole filesystem. Running
   * it because a repository asked would undo every boundary the rest of Cowork
   * maintains.
   */
  | 'unsupported-confinement'
  /**
   * Found in a subdirectory, and not applied.
   *
   * A nested instruction file is scoped to its own subtree: it applies while
   * work happens under that directory and not elsewhere. Jan builds one system
   * prompt per run and the dispatcher has no notion of a current directory, so
   * there is nothing here that could turn "applies under `packages/api`" into
   * behaviour. Concatenating them all into the global prompt would apply every
   * subtree's rules to every file — the opposite of what the file means — so
   * they are listed, with their scope, and not read.
   */
  | 'unsupported-scoping'

/** Where a component came from. */
export type CompatSource = 'project' | 'user' | 'plugin'

export type CompatComponent = {
  /** Stable across runs, so readiness and dispatch name the same thing. */
  id: string
  type: CompatComponentType
  name: string
  source: CompatSource
  /** Canonical, as resolved — never as written. Null where there is no file. */
  path: string | null
  /** Did the user switch this on? */
  enabled: boolean
  state: CompatState
  /** Why, in the states where "why" is the whole content. */
  reason?: string
  /** Tools, skills or servers this needs, once resolved. */
  dependencies?: string[]
  /**
   * What the definition says it is for, as written.
   *
   * Carried for an agent because the dispatching model chooses between agents
   * by their descriptions; without it an imported agent is a name with nothing
   * behind it.
   */
  description?: string
  /**
   * The subtree this component governs, for a nested instruction file.
   *
   * Absent means it applies to the whole repository.
   */
  scope?: string
  /**
   * The part safe to put in front of the model.
   *
   * Present only for components whose text is meant to be read as
   * instructions. Never carries a secret, a grant, or a path outside the
   * repository.
   */
  content?: string
}

export type CompatibilityManifest = {
  binding: Binding
  /** Did the user turn compatibility on for this repository? */
  enabled: boolean
  components: CompatComponent[]
}

/** A manifest that claims nothing, for a binding with no compatibility. */
export const emptyManifest = (binding: Binding): CompatibilityManifest => ({
  binding,
  enabled: false,
  components: [],
})

/**
 * Is this manifest still the one for the binding in front of us?
 *
 * Same reason readiness is snapshotted: a scan for the previous folder that
 * resolves after the user has attached another describes a repository nobody
 * is looking at, and its components must not be activated.
 */
export const manifestMatches = (
  manifest: CompatibilityManifest | null,
  binding: Binding
): boolean => manifest != null && sameBinding(manifest.binding, binding)

/** Beyond this an instruction file is reported rather than read. */
export const MAX_COMPAT_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// Containment

/**
 * Resolve a path that a repository asked for, inside the repository.
 *
 * The single choke point for every path in this file. Repository content names
 * the paths — a skill's resource, an agent file, an MCP working directory —
 * and repository content is exactly what must not be trusted to stay inside
 * the folder the user chose. `../note-py` and a symlink to it are the same
 * attack; this catches the first, and the caller is responsible for handing in
 * a path the backend has already resolved for the second.
 */
export function containedPath(root: string, path: string): string | null {
  return resolveInRoot(root, path)
}

/** Does this path stay inside the repository? */
export const isContained = (root: string, path: string): boolean =>
  containedPath(root, path) !== null

// ---------------------------------------------------------------------------
// Instructions

/** One instruction file, as read from disk. */
export type InstructionProbe = {
  name: string
  path: string
  content?: string | null
  error?: string | null
  /**
   * Already canonicalized by the backend, and confirmed inside the repository.
   *
   * Passed in rather than decided here because only the backend can resolve a
   * symlink; a path that looks contained in a string can still point out of
   * the repository on disk.
   */
  canonicalInside?: boolean
  /**
   * The directory this file governs, relative to the repository root.
   *
   * Absent for the root file, which governs everything. Present means nested,
   * and nested means scoped — which is the thing Jan cannot reproduce.
   */
  scope?: string
}

/**
 * Classify one Claude instruction file.
 *
 * Active only when compatibility is on, the file was actually read, and it
 * stayed inside the repository. Every other outcome is reported and not read:
 * an oversized or escaping `CLAUDE.md` must not look like instructions that
 * landed.
 */
export function classifyCompatInstruction(
  probe: InstructionProbe,
  opts: { enabled: boolean; root: string | null }
): CompatComponent {
  const base = {
    id: `instructions:${probe.scope ?? ''}${probe.name}`,
    type: 'instructions' as const,
    // Named by where it is, so two `CLAUDE.md` files are told apart in the
    // list by the thing that actually distinguishes them.
    name: probe.scope ? `${probe.scope}/${probe.name}` : probe.name,
    source: 'project' as const,
    path: probe.path,
    enabled: opts.enabled,
  }

  if (probe.error) {
    return { ...base, state: 'unreadable', reason: probe.error }
  }
  if (probe.content == null) {
    // Not there is not a failure, and not silence either.
    return { ...base, state: 'unsupported', reason: 'not present' }
  }
  if (
    !opts.root ||
    !isContained(opts.root, probe.path) ||
    probe.canonicalInside === false
  ) {
    return {
      ...base,
      state: 'path-escape',
      reason: 'resolves outside the attached folder',
    }
  }
  const bytes = new TextEncoder().encode(probe.content).length
  if (bytes > MAX_COMPAT_BYTES) {
    return {
      ...base,
      state: 'oversized',
      reason: `${bytes} bytes exceeds ${MAX_COMPAT_BYTES}`,
    }
  }
  if (probe.content.trim().length === 0) {
    return { ...base, state: 'unsupported', reason: 'empty' }
  }
  return {
    ...base,
    state: opts.enabled ? 'active' : 'available',
    content: opts.enabled ? probe.content : undefined,
    // Carried so every consumer can tell a repository-wide file from one that
    // governs a subtree. Absent means the whole repository.
    ...(probe.scope ? { scope: probe.scope } : {}),
  }
}

// ---------------------------------------------------------------------------
// Directory-scoped instructions

/**
 * One instruction file, and the subtree it governs.
 *
 * A nested `CLAUDE.md` applies to work under its own directory and nowhere
 * else. Jan builds one system prompt per run, so the nested files cannot all
 * be poured into it — that would apply each subtree's rules to every file,
 * which is the opposite of what the file means. Instead the applicable chain
 * is resolved per path, at the moment a path is actually touched.
 */
export type ScopedInstruction = {
  /** Repository-relative directory. Empty for the repository-wide file. */
  scope: string
  name: string
  content: string
}

/** Is `dir` this path's own directory or one of its ancestors? */
const governs = (dir: string, path: string): boolean => {
  if (dir === '') return true
  const scope = dir.replace(/\/+$/, '')
  // Component-wise: `packages/api` must not govern `packages/api-legacy`.
  return path === scope || path.startsWith(`${scope}/`)
}

/**
 * The instruction chain that applies to one repository-relative path.
 *
 * Shallowest first, so a deeper file is read after — and therefore overrides —
 * the one above it. The repository-wide file is always first when there is
 * one; a sibling subtree's file never appears at all.
 */
export function scopedInstructionChain(
  manifest: CompatibilityManifest,
  relPath: string
): ScopedInstruction[] {
  const path = relPath.replace(/^\/+/, '').replace(/\\/g, '/')
  return activeComponents(manifest, 'instructions')
    .filter(
      (one): one is CompatComponent & { content: string } =>
        Boolean(one.content) && governs(one.scope ?? '', path)
    )
    .map((one) => ({
      scope: one.scope ?? '',
      name: one.name,
      content: one.content,
    }))
    .sort(
      (a, b) =>
        (a.scope === '' ? 0 : a.scope.split('/').length) -
        (b.scope === '' ? 0 : b.scope.split('/').length)
    )
}

/**
 * The nested part of that chain: what the prompt has not already said.
 *
 * The repository-wide file is in the system prompt from the first token. Only
 * the subtree files have to be delivered when work reaches their subtree.
 */
export const nestedChainFor = (
  manifest: CompatibilityManifest,
  relPath: string
): ScopedInstruction[] =>
  scopedInstructionChain(manifest, relPath).filter((one) => one.scope !== '')

/**
 * Which instruction file wins where they disagree.
 *
 * `JAN.md` is what a user wrote *for Jan*, so it outranks a file written for
 * another harness. Neither outranks the system prompt or the frozen binding
 * and access policy: no instruction file, however phrased, moves the
 * repository or grants a tool.
 */
export const INSTRUCTION_PRECEDENCE = [
  'system',
  'cowork-policy',
  'JAN.md',
  'CLAUDE.md',
] as const

export type InstructionPrecedence = (typeof INSTRUCTION_PRECEDENCE)[number]

/** The order the reader is shown, highest authority first. */
export function instructionOrder(
  names: readonly string[]
): InstructionPrecedence[] {
  return INSTRUCTION_PRECEDENCE.filter(
    (one) => one === 'system' || one === 'cowork-policy' || names.includes(one)
  )
}

// ---------------------------------------------------------------------------
// Skills

/** One `SKILL.md` package, as found. */
export type SkillProbe = {
  name: string
  /** The skill's own directory. Resources resolve relative to it. */
  dir: string
  source: CompatSource
  frontmatter?: Record<string, unknown> | null
  content?: string | null
  error?: string | null
  /** Paths the skill refers to, as written. */
  resources?: readonly string[]
  canonicalInside?: boolean
}

/**
 * Classify one Claude-compatible skill package.
 *
 * A skill is text and resources, never an executable: a bundled script is
 * listed, not run. The containment check covers the whole package, because a
 * resource pointing at `../../note-py/.env` is a read of another repository
 * dressed up as a skill asset.
 */
export function classifyCompatSkill(
  probe: SkillProbe,
  opts: { enabled: boolean; root: string | null; enabledNames: Set<string> }
): CompatComponent {
  const base = {
    id: `skill:${probe.source}:${probe.name}`,
    type: 'skill' as const,
    name: probe.name,
    source: probe.source,
    path: probe.dir,
    enabled: opts.enabled && opts.enabledNames.has(probe.name),
  }

  if (probe.error) return { ...base, state: 'unreadable', reason: probe.error }
  if (probe.content == null || !probe.frontmatter) {
    return { ...base, state: 'malformed', reason: 'no readable SKILL.md' }
  }

  // A project skill must stay in the project. A user-level directory is one
  // Jan was configured with, so the repository cannot invent it — but its own
  // resources still have to stay inside the skill.
  const containmentRoot = probe.source === 'project' ? opts.root : probe.dir
  if (!containmentRoot) {
    return { ...base, state: 'unsupported', reason: 'no folder attached' }
  }
  if (
    !isContained(containmentRoot, probe.dir) ||
    probe.canonicalInside === false
  ) {
    return {
      ...base,
      state: 'path-escape',
      reason: 'skill directory resolves outside its root',
    }
  }
  const escaping = (probe.resources ?? []).find(
    (resource) => !isContained(probe.dir, resource)
  )
  if (escaping) {
    return {
      ...base,
      state: 'path-escape',
      reason: `resource resolves outside the skill: ${escaping}`,
    }
  }

  if (!opts.enabled) return { ...base, state: 'available' }
  if (!opts.enabledNames.has(probe.name)) {
    return { ...base, state: 'disabled' }
  }
  return { ...base, state: 'active', content: probe.content }
}

// ---------------------------------------------------------------------------
// Agents

/** Fields Jan can reproduce from a Claude agent definition. */
export type AgentProbe = {
  name: string
  path: string
  description?: string | null
  /** Tools the definition asks for, as written. */
  tools?: readonly string[]
  /** Its system prompt body. */
  content?: string | null
  error?: string | null
  /** Fields present that Jan has no faithful equivalent for. */
  unsupportedFields?: readonly string[]
  canonicalInside?: boolean
}

/**
 * The tools an imported agent actually gets.
 *
 * An intersection, never a union. The definition is a request written by
 * whoever wrote the repository; the available set is what this run advertises.
 * Anything asked for and not available is reported before launch rather than
 * failing mid-run, and nothing asked for can add a tool the run does not have.
 */
export function intersectAgentTools(
  requested: readonly string[] | undefined,
  available: readonly string[]
): { granted: string[]; missing: string[] } {
  // No `tools:` means "whatever the parent has", which is already the ceiling.
  if (!requested) return { granted: [...available], missing: [] }
  const have = new Set(available)
  return {
    granted: requested.filter((one) => have.has(one)),
    missing: requested.filter((one) => !have.has(one)),
  }
}

export function classifyCompatAgent(
  probe: AgentProbe,
  opts: {
    enabled: boolean
    root: string | null
    availableTools: readonly string[]
    /** Agents the user saved in Jan. Those names are taken. */
    savedAgentNames?: readonly string[]
  }
): CompatComponent {
  const base = {
    id: `agent:${probe.name}`,
    type: 'agent' as const,
    name: probe.name,
    source: 'project' as const,
    path: probe.path,
    enabled: opts.enabled,
    description: probe.description ?? '',
  }

  if (probe.error) return { ...base, state: 'unreadable', reason: probe.error }
  if (!probe.content) {
    return { ...base, state: 'malformed', reason: 'no agent body' }
  }
  if (opts.savedAgentNames?.includes(probe.name)) {
    // Reported, not silently dropped: someone who wrote this file and never
    // saw it run deserves to know a saved definition holds the name.
    return {
      ...base,
      state: 'duplicate',
      reason: 'a subagent saved in Jan already has this name',
    }
  }
  if (
    !opts.root ||
    !isContained(opts.root, probe.path) ||
    probe.canonicalInside === false
  ) {
    return {
      ...base,
      state: 'path-escape',
      reason: 'resolves outside the attached folder',
    }
  }

  const { granted, missing } = intersectAgentTools(
    probe.tools,
    opts.availableTools
  )
  const unsupported = probe.unsupportedFields ?? []

  if (!opts.enabled) {
    return { ...base, state: 'available', dependencies: granted }
  }
  if (missing.length > 0) {
    // Said before launch, not discovered mid-run: an agent that silently loses
    // half its tools produces work that looks finished and is not.
    return {
      ...base,
      state: 'missing-dependency',
      reason: `not available here: ${missing.join(', ')}`,
      dependencies: granted,
    }
  }
  return {
    ...base,
    state: 'active',
    dependencies: granted,
    content: probe.content,
    ...(unsupported.length > 0
      ? { reason: `ignored fields: ${unsupported.join(', ')}` }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// MCP

/** One MCP server definition, as written in Claude configuration. */
export type McpProbe = {
  name: string
  source: CompatSource
  path: string | null
  transport?: 'stdio' | 'http' | 'sse' | string | null
  command?: string | null
  /** Kept as argv. Never joined into a string. */
  args?: readonly string[]
  url?: string | null
  /** Names only. Values never travel through this file. */
  envNames?: readonly string[]
  cwd?: string | null
  error?: string | null
}

/**
 * Can this platform confine a local MCP server?
 *
 * Asked of the sandbox backend, never assumed. An imported stdio server runs
 * through the same confinement the agent's own shell runs under — one
 * implementation of the boundary, so a second MCP-shaped imitation of it
 * cannot drift from the real one — and a platform with no backend refuses the
 * import rather than launching it unconfined. A server the user configured
 * themselves keeps the behaviour it has always had: they chose the program.
 */
export type ConfinementSupport = { stdio: boolean }

export const NO_LOCAL_CONFINEMENT: ConfinementSupport = { stdio: false }

/**
 * What can be done with an imported MCP server.
 *
 * Consent is required for every one of them, and consent is not enough for a
 * local process: the boundary has to exist before the user can be asked to
 * cross it. A remote server starts no process here, so it needs only consent
 * and Jan's ordinary network and secret policy.
 */
export function classifyCompatMcp(
  probe: McpProbe,
  opts: {
    enabled: boolean
    consented: Set<string>
    initialized: Set<string>
    initFailed: Map<string, string>
    confinement: ConfinementSupport
    duplicateOf?: string | null
  }
): CompatComponent {
  const base = {
    id: `mcp:${probe.source}:${probe.name}`,
    type: 'mcp' as const,
    name: probe.name,
    source: probe.source,
    path: probe.path,
    enabled: opts.enabled && opts.consented.has(probe.name),
    // Carried in every state, not only once it is running: the names are what
    // the user is deciding about when they are asked to consent, and asking
    // them to allow a server without saying what it will be given is not a
    // question they can answer.
    dependencies: [...(probe.envNames ?? [])],
  }

  if (probe.error) return { ...base, state: 'unreadable', reason: probe.error }
  if (opts.duplicateOf) {
    // Two definitions of one name cannot both be live: the second would
    // shadow the first, and a tool call would reach whichever won a race.
    return {
      ...base,
      state: 'duplicate',
      reason: `also defined by ${opts.duplicateOf}`,
    }
  }

  const transport = probe.transport ?? (probe.command ? 'stdio' : null)
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    return {
      ...base,
      state: 'unsupported',
      reason: `transport ${String(transport ?? 'unknown')}`,
    }
  }
  if (transport === 'stdio') {
    if (!probe.command) {
      return { ...base, state: 'malformed', reason: 'no command' }
    }
    if (!opts.confinement.stdio) {
      return {
        ...base,
        state: 'unsupported-confinement',
        reason:
          'a local server imported from repository configuration would run ' +
          'unconfined on this platform',
      }
    }
  }
  if (transport !== 'stdio' && !probe.url) {
    return { ...base, state: 'malformed', reason: 'no url' }
  }

  if (!opts.enabled) return { ...base, state: 'available' }
  if (!opts.consented.has(probe.name))
    return { ...base, state: 'consent-required' }
  const failure = opts.initFailed.get(probe.name)
  if (failure) return { ...base, state: 'init-failed', reason: failure }
  // Not "consented" but "answered": a server that has not finished starting
  // has no tools, and saying it is active would advertise tools that are not
  // there.
  if (!opts.initialized.has(probe.name)) {
    return { ...base, state: 'init-failed', reason: 'not initialized' }
  }
  return { ...base, state: 'active' }
}

/**
 * The Jan MCP configuration for an imported server.
 *
 * Structured executable plus argv, never a shell string: a path with a space,
 * a quote or a flag-shaped name is data, and flattening it into a command line
 * turns that data into arguments. Environment values are not carried here —
 * only the names, so the user can see what the server will be given and supply
 * the values through Jan's own secret handling.
 */
export type McpConfinementRequest = {
  /** The session workspace: readable and writable. */
  workspace: string
  /** The attached repository, readable. */
  repository?: string
  /** Writable, only where a live direct-edit grant says so. */
  writableRepository?: string
  /** Jan's data folder, hidden from the server. */
  janData?: string
  /** Environment names the user approved. Nothing else is passed through. */
  allowedEnv: string[]
}

export function toJanMcpConfig(
  probe: McpProbe,
  confinement?: McpConfinementRequest
): {
  command: string
  args: string[]
  env: Record<string, string>
  type: 'stdio' | 'http' | 'sse'
  url?: string
  /**
   * Marks this as a definition a repository supplied.
   *
   * The backend refuses to start an imported server that carries no
   * confinement, so this is what makes a missing one fail closed instead of
   * launching with the user's whole filesystem in reach. Written by Jan, never
   * copied from the repository's file — the fields below are the only ones
   * this function emits, so a `.mcp.json` cannot declare itself trusted.
   */
  janImported: true
  janConfinement?: McpConfinementRequest
} | null {
  const transport = probe.transport ?? (probe.command ? 'stdio' : null)
  const marks = {
    janImported: true as const,
    ...(confinement ? { janConfinement: confinement } : {}),
  }
  if (transport === 'stdio') {
    if (!probe.command) return null
    return {
      command: probe.command,
      args: [...(probe.args ?? [])],
      env: {},
      type: 'stdio',
      ...marks,
    }
  }
  if (transport === 'http' || transport === 'sse') {
    if (!probe.url) return null
    return {
      command: '',
      args: [],
      env: {},
      type: transport,
      url: probe.url,
      ...marks,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Commands, hooks and plugins

/** Something found and deliberately not run. */
export type InertProbe = {
  name: string
  type: 'command' | 'hook' | 'plugin'
  path: string
  source: CompatSource
  /** For a plugin: the parts of it Jan can use, listed separately. */
  parts?: readonly string[]
}

/**
 * Inventory a component Jan will not execute.
 *
 * Listed rather than hidden. A user whose hook does not fire needs to know it
 * was seen and skipped; silence would read as "it ran".
 */
export function classifyInert(probe: InertProbe): CompatComponent {
  return {
    id: `${probe.type}:${probe.name}`,
    type: probe.type,
    name: probe.name,
    source: probe.source,
    path: probe.path,
    enabled: false,
    state: 'unsupported',
    reason:
      probe.type === 'plugin'
        ? 'installed components are listed separately; the plugin itself is not run'
        : 'detected and not executed',
    ...(probe.parts && probe.parts.length > 0
      ? { dependencies: [...probe.parts] }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// The manifest

/** Everything the resolver was given about one repository. */
export type CompatProbes = {
  instructions: readonly InstructionProbe[]
  skills: readonly SkillProbe[]
  agents: readonly AgentProbe[]
  mcp: readonly McpProbe[]
  inert: readonly InertProbe[]
}

export type ResolveOptions = {
  binding: Binding
  /** Did the user switch compatibility on for this repository? */
  enabled: boolean
  /** Skills switched on by name. */
  enabledSkills: Set<string>
  /** Tools this run actually advertises. */
  availableTools: readonly string[]
  /** MCP servers the user has allowed, by name. */
  consentedMcp: Set<string>
  initializedMcp: Set<string>
  failedMcp: Map<string, string>
  confinement: ConfinementSupport
  /** Agents the user saved in Jan; those names are already taken. */
  savedAgentNames?: readonly string[]
}

/**
 * Resolve one repository's Claude configuration into a run-ready manifest.
 *
 * The single place any of this is decided. Readiness, prompt construction and
 * dispatch read the result; none of them scans for themselves, because three
 * scans at three moments is three different answers to "what is in force", and
 * the user is shown one of them while another is used.
 */
export function resolveCompatibility(
  probes: CompatProbes,
  opts: ResolveOptions
): CompatibilityManifest {
  const root = opts.binding.folder
  const components: CompatComponent[] = []
  const claimed = new Map<string, string>()

  for (const probe of probes.instructions) {
    components.push(
      classifyCompatInstruction(probe, { enabled: opts.enabled, root })
    )
  }

  for (const probe of probes.skills) {
    const resolved = classifyCompatSkill(probe, {
      enabled: opts.enabled,
      root,
      enabledNames: opts.enabledSkills,
    })
    // A name can be claimed once. The second definition is reported, not
    // quietly ignored: the user has two skills and is using neither knowingly.
    const key = `skill:${probe.name}`
    const first = claimed.get(key)
    components.push(
      first
        ? {
            ...resolved,
            state: 'duplicate',
            reason: `also defined by ${first}`,
            content: undefined,
          }
        : resolved
    )
    if (!first) claimed.set(key, probe.dir)
  }

  for (const probe of probes.agents) {
    components.push(
      classifyCompatAgent(probe, {
        enabled: opts.enabled,
        root,
        availableTools: opts.availableTools,
        savedAgentNames: opts.savedAgentNames,
      })
    )
  }

  const mcpSeen = new Map<string, string>()
  for (const probe of probes.mcp) {
    const duplicateOf = mcpSeen.get(probe.name) ?? null
    components.push(
      classifyCompatMcp(probe, {
        enabled: opts.enabled,
        consented: opts.consentedMcp,
        initialized: opts.initializedMcp,
        initFailed: opts.failedMcp,
        confinement: opts.confinement,
        duplicateOf,
      })
    )
    if (!duplicateOf) mcpSeen.set(probe.name, probe.path ?? probe.source)
  }

  for (const probe of probes.inert) components.push(classifyInert(probe))

  return { binding: opts.binding, enabled: opts.enabled, components }
}

/** The components in force for a run. */
export const activeComponents = (
  manifest: CompatibilityManifest,
  type?: CompatComponentType
): CompatComponent[] =>
  manifest.components.filter(
    (one) => one.state === 'active' && (!type || one.type === type)
  )

/**
 * Fold compatibility skills into the registry a run resolves requests against.
 *
 * Merged rather than kept in a second list, so a request for a skill resolves
 * once against everything that exists. A Claude-compatible skill sharing a
 * name with a Jan-native one lands as `ambiguous` — which blocks mutation and
 * shows the user both — instead of one silently shadowing the other and the
 * run following instructions nobody chose.
 */
export function mergeSkillRegistry(
  manifest: CompatibilityManifest,
  registry: { available: { name: string }[]; enabled: ReadonlySet<string> }
): { available: { name: string }[]; enabled: ReadonlySet<string> } {
  const skills = manifest.components.filter((one) => one.type === 'skill')
  // A skill Jan refused — escaping, malformed, duplicate — is not offered as
  // available: a request for it must resolve to `missing`, not to something
  // that then fails to load.
  const usable = skills.filter(
    (one) => one.state === 'active' || one.state === 'disabled'
  )
  return {
    available: [
      ...registry.available,
      ...usable.map((one) => ({ name: one.name })),
    ],
    enabled: new Set([
      ...registry.enabled,
      ...skills.filter((one) => one.state === 'active').map((one) => one.name),
    ]),
  }
}

/**
 * Imported agents, as definitions the `task` tool can actually run.
 *
 * Only the active ones. An agent Jan refused — escaping the folder,
 * malformed, missing a tool it asked for — is not offered as something to
 * dispatch: a request for it must fail as unknown rather than launch
 * something that quietly is not what the repository described.
 *
 * The tools are the intersection already computed at classification, so this
 * cannot widen anything; `resolveSubagent` intersects again against the
 * parent's set at dispatch, which is the ceiling that actually holds.
 *
 * Jan's own saved definitions win a name collision, and the caller is told
 * which imported ones were shadowed: a repository must not be able to
 * redefine an agent the user configured for themselves by choosing its name.
 */
export type ImportedAgentDefinition = {
  name: string
  description: string
  system_prompt: string
  allowed_tools: string[] | null
  model: string | null
}

export function importedAgents(
  manifest: CompatibilityManifest,
  saved: readonly { name: string }[]
): {
  definitions: ImportedAgentDefinition[]
  shadowed: string[]
} {
  const own = new Set(saved.map((one) => one.name))
  const definitions: ImportedAgentDefinition[] = []
  const shadowed: string[] = []

  for (const one of manifest.components) {
    if (one.type !== 'agent' || one.state !== 'active' || !one.content) continue
    if (own.has(one.name)) {
      shadowed.push(one.name)
      continue
    }
    definitions.push({
      name: one.name,
      description: one.description ?? '',
      system_prompt: one.content,
      // Already intersected against what this run advertises. Null would mean
      // "everything the parent has", which is not what a definition naming
      // tools asked for.
      allowed_tools: [...(one.dependencies ?? [])],
      // Never the model the definition named: choosing a model is the user's,
      // and a repository naming one would be configuration arriving as
      // instruction. Reported as an ignored field at classification.
      model: null,
    })
  }
  return { definitions, shadowed: shadowed.sort() }
}

/** Compatibility instruction text to put in front of the model, in order. */
export function compatInstructionBlocks(
  manifest: CompatibilityManifest
): { name: string; content: string }[] {
  return activeComponents(manifest, 'instructions')
    .filter(
      (one): one is CompatComponent & { content: string } =>
        // Repository-wide only. A subtree's file is delivered when work
        // reaches that subtree; putting it here would apply it everywhere.
        Boolean(one.content) && !one.scope
    )
    .map((one) => ({ name: one.name, content: one.content }))
}
