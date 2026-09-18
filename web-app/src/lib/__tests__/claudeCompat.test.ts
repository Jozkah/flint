import { describe, expect, it } from 'vitest'
import {
  classifyCompatAgent,
  classifyCompatInstruction,
  classifyCompatMcp,
  classifyCompatSkill,
  classifyInert,
  compatInstructionBlocks,
  emptyManifest,
  importedAgents,
  instructionOrder,
  intersectAgentTools,
  isContained,
  manifestMatches,
  resolveCompatibility,
  toJanMcpConfig,
  isFilesystemServer,
  filesystemAllowedDirs,
  FILESYSTEM_SERVER_PACKAGE,
  type CompatComponent,
  type CompatibilityManifest,
  type CompatProbes,
  type ResolveOptions,
  MAX_COMPAT_BYTES,
  NO_LOCAL_CONFINEMENT,
} from '@/lib/claudeCompat'

/**
 * The fixture is three sibling repositories, because that is the shape of the
 * failure this whole surface exists to prevent: work in one repository
 * reaching into the one next to it. `obs-forwarder-backup` is there on
 * purpose — it shares a prefix with the selected repository, and any
 * containment check written with string prefixes lets it through.
 */
const ROOT = '/home/dev/obs-forwarder'
const SIBLING = '/home/dev/note-py'
const PREFIX_SIBLING = '/home/dev/obs-forwarder-backup'
const SESSION = 'session-a'
const binding = { sessionId: SESSION, folder: ROOT }

const CONFINED = { stdio: true }

const options = (over: Partial<ResolveOptions> = {}): ResolveOptions => ({
  binding,
  enabled: true,
  enabledSkills: new Set<string>(),
  availableTools: ['read', 'write', 'bash'],
  consentedMcp: new Set<string>(),
  initializedMcp: new Set<string>(),
  failedMcp: new Map<string, string>(),
  confinement: NO_LOCAL_CONFINEMENT,
  ...over,
})

const probes = (over: Partial<CompatProbes> = {}): CompatProbes => ({
  instructions: [],
  skills: [],
  agents: [],
  mcp: [],
  inert: [],
  ...over,
})

describe('staying inside the repository the user chose', () => {
  it('accepts a path inside it', () => {
    expect(isContained(ROOT, `${ROOT}/src/a.ts`)).toBe(true)
    expect(isContained(ROOT, 'src/a.ts')).toBe(true)
  })

  // The prefix sibling. A string-prefix check calls this contained; it is not.
  it('rejects a sibling whose name starts the same way', () => {
    expect(isContained(ROOT, `${PREFIX_SIBLING}/src/a.ts`)).toBe(false)
  })

  it.each([
    ['a sibling', `${SIBLING}/.env`],
    ['traversal out and back', `${ROOT}/../note-py/.env`],
    ['traversal to the parent', `${ROOT}/../`],
  ])('rejects %s', (_name, path) => {
    expect(isContained(ROOT, path)).toBe(false)
  })
})

describe('Claude instructions', () => {
  const probe = {
    name: 'CLAUDE.md',
    path: `${ROOT}/CLAUDE.md`,
    content: 'Prefer small commits.',
  }

  // Detection is not activation: the file being there means only that.
  it('is available, not active, until compatibility is switched on', () => {
    const off = classifyCompatInstruction(probe, {
      enabled: false,
      root: ROOT,
    })

    expect(off.state).toBe('available')
    expect(off.content).toBeUndefined()
  })

  it('is read once the user switches compatibility on', () => {
    const on = classifyCompatInstruction(probe, { enabled: true, root: ROOT })

    expect(on.state).toBe('active')
    expect(on.content).toBe('Prefer small commits.')
  })

  it('is never read from outside the attached folder', () => {
    const outside = classifyCompatInstruction(
      { ...probe, path: `${SIBLING}/CLAUDE.md` },
      { enabled: true, root: ROOT }
    )

    expect(outside.state).toBe('path-escape')
    expect(outside.content).toBeUndefined()
  })

  // A path that reads as contained can still be a symlink out of the tree.
  // Only the backend can tell, so its answer overrides the string check.
  it('is refused when the backend says the real path escapes', () => {
    const linked = classifyCompatInstruction(
      { ...probe, canonicalInside: false },
      { enabled: true, root: ROOT }
    )

    expect(linked.state).toBe('path-escape')
  })

  it.each([
    [
      'oversized',
      { ...probe, content: 'x'.repeat(MAX_COMPAT_BYTES + 1) },
      'oversized',
    ],
    ['unreadable', { ...probe, error: 'EACCES' }, 'unreadable'],
    ['empty', { ...probe, content: '   \n' }, 'unsupported'],
  ])('reports a %s file rather than reading it', (_n, p, expected) => {
    const result = classifyCompatInstruction(p, { enabled: true, root: ROOT })

    expect(result.state).toBe(expected)
    expect(result.content).toBeUndefined()
  })

  /**
   * Precedence is the whole point of showing this at all. A user with both
   * files needs to know which one the run followed, and that neither of them
   * outranks Jan's own policy.
   */
  it('ranks below JAN.md, and both below policy', () => {
    expect(instructionOrder(['JAN.md', 'CLAUDE.md'])).toEqual([
      'system',
      'cowork-policy',
      'JAN.md',
      'CLAUDE.md',
    ])
  })

  it('still ranks below policy when it is the only file', () => {
    expect(instructionOrder(['CLAUDE.md'])).toEqual([
      'system',
      'cowork-policy',
      'CLAUDE.md',
    ])
  })
})

describe('Claude-compatible skills', () => {
  const skill = {
    name: 'reviewer',
    dir: `${ROOT}/.claude/skills/reviewer`,
    source: 'project' as const,
    frontmatter: { name: 'reviewer' },
    content: 'Review carefully.',
  }

  it('is disabled until the user switches it on by name', () => {
    const off = classifyCompatSkill(skill, {
      enabled: true,
      root: ROOT,
      enabledNames: new Set(),
    })

    expect(off.state).toBe('disabled')
    expect(off.content).toBeUndefined()
  })

  it('is active once enabled, and carries its instructions', () => {
    const on = classifyCompatSkill(skill, {
      enabled: true,
      root: ROOT,
      enabledNames: new Set(['reviewer']),
    })

    expect(on.state).toBe('active')
    expect(on.content).toBe('Review carefully.')
  })

  // The mutation this prevents: dropping resource containment, so a skill's
  // "asset" reads a file out of the repository next door.
  it('refuses a resource that resolves outside the skill', () => {
    const escaping = classifyCompatSkill(
      { ...skill, resources: ['../../../note-py/.env'] },
      { enabled: true, root: ROOT, enabledNames: new Set(['reviewer']) }
    )

    expect(escaping.state).toBe('path-escape')
    expect(escaping.content).toBeUndefined()
  })

  it('refuses a project skill living outside the project', () => {
    const outside = classifyCompatSkill(
      { ...skill, dir: `${SIBLING}/.claude/skills/reviewer` },
      { enabled: true, root: ROOT, enabledNames: new Set(['reviewer']) }
    )

    expect(outside.state).toBe('path-escape')
  })

  it('reports a package with no readable SKILL.md as malformed', () => {
    const broken = classifyCompatSkill(
      { ...skill, frontmatter: null, content: null },
      { enabled: true, root: ROOT, enabledNames: new Set(['reviewer']) }
    )

    expect(broken.state).toBe('malformed')
  })

  // A user-level directory is one Jan was configured with. Its skills are not
  // inside the repository and must not be judged against it.
  it('allows a configured user-level skill outside the repository', () => {
    const user = classifyCompatSkill(
      { ...skill, source: 'user', dir: '/home/dev/.claude/skills/reviewer' },
      { enabled: true, root: ROOT, enabledNames: new Set(['reviewer']) }
    )

    expect(user.state).toBe('active')
  })
})

describe('imported agent definitions', () => {
  const agent = {
    name: 'reviewer',
    path: `${ROOT}/.claude/agents/reviewer.md`,
    content: 'You review code.',
    tools: ['read', 'write'],
  }

  /**
   * An imported definition is configuration, never authority. Whatever it asks
   * for, it can only ever get the intersection with what this run already has.
   */
  it('gets the intersection of what it asked for and what exists', () => {
    expect(intersectAgentTools(['read', 'rm -rf'], ['read', 'write'])).toEqual({
      granted: ['read'],
      missing: ['rm -rf'],
    })
  })

  it('cannot add a tool this run does not advertise', () => {
    const { granted } = intersectAgentTools(
      ['read', 'deploy_to_production'],
      ['read']
    )

    expect(granted).toEqual(['read'])
  })

  it('inherits the parent’s whole set when it asks for nothing', () => {
    expect(intersectAgentTools(undefined, ['read', 'write'])).toEqual({
      granted: ['read', 'write'],
      missing: [],
    })
  })

  it('says what is missing before launch rather than failing mid-run', () => {
    const result = classifyCompatAgent(
      { ...agent, tools: ['read', 'browse'] },
      { enabled: true, root: ROOT, availableTools: ['read'] }
    )

    expect(result.state).toBe('missing-dependency')
    expect(result.reason).toContain('browse')
  })

  it('refuses to redefine an agent the user saved in Jan', () => {
    // A repository must not be able to take over a name the user configured
    // for themselves by choosing it.
    const result = classifyCompatAgent(agent, {
      enabled: true,
      root: ROOT,
      availableTools: ['read', 'write'],
      savedAgentNames: [agent.name],
    })

    expect(result.state).toBe('duplicate')
    expect(result.reason).toContain('saved in Jan')
    // And nothing dispatchable comes out of it.
    expect(result.content).toBeUndefined()
  })

  it('is active with its granted tools when everything resolves', () => {
    const result = classifyCompatAgent(agent, {
      enabled: true,
      root: ROOT,
      availableTools: ['read', 'write', 'bash'],
    })

    expect(result.state).toBe('active')
    expect(result.dependencies).toEqual(['read', 'write'])
  })

  // Silently translating a field Jan cannot reproduce would leave the user
  // believing their configuration is in force.
  it('names the fields it ignored rather than guessing at them', () => {
    const result = classifyCompatAgent(
      { ...agent, unsupportedFields: ['permission-mode', 'hooks'] },
      { enabled: true, root: ROOT, availableTools: ['read', 'write'] }
    )

    expect(result.state).toBe('active')
    expect(result.reason).toContain('permission-mode')
    expect(result.reason).toContain('hooks')
  })

  it('refuses a definition outside the attached folder', () => {
    const result = classifyCompatAgent(
      { ...agent, path: `${PREFIX_SIBLING}/.claude/agents/reviewer.md` },
      { enabled: true, root: ROOT, availableTools: ['read', 'write'] }
    )

    expect(result.state).toBe('path-escape')
  })
})

describe('imported MCP servers', () => {
  const local = {
    name: 'files',
    source: 'project' as const,
    path: `${ROOT}/.mcp.json`,
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', ROOT],
    envNames: ['API_TOKEN'],
  }
  const remote = {
    name: 'docs',
    source: 'project' as const,
    path: `${ROOT}/.mcp.json`,
    transport: 'http' as const,
    url: 'https://example.test/mcp',
  }

  const mcp = (probe: typeof local | typeof remote, over = {}) =>
    classifyCompatMcp(probe, {
      enabled: true,
      consented: new Set<string>(),
      initialized: new Set<string>(),
      initFailed: new Map<string, string>(),
      confinement: NO_LOCAL_CONFINEMENT,
      ...over,
    })

  /**
   * The decision this file exists to record. Jan's launcher starts a stdio
   * server as an ordinary child: the parent's environment, no filesystem
   * restriction, no working-directory pin. That is a choice a user can make
   * for themselves; it is not one a repository gets to make for them.
   */
  it('refuses a local server it cannot confine, whatever the user consents to', () => {
    const result = mcp(local, { consented: new Set(['files']) })

    expect(result.state).toBe('unsupported-confinement')
    expect(result.enabled).toBe(true)
    expect(result.reason).toContain('unconfined')
  })

  it('would allow a local server on a platform that can confine it', () => {
    const result = mcp(local, {
      confinement: { stdio: true },
      consented: new Set(['files']),
      initialized: new Set(['files']),
    })

    expect(result.state).toBe('active')
  })

  // Detection starts nothing. Consent is a separate, explicit act.
  it('waits for consent before a remote server is used', () => {
    expect(mcp(remote).state).toBe('consent-required')
  })

  it('is not active until it has actually initialized', () => {
    const consented = mcp(remote, { consented: new Set(['docs']) })

    expect(consented.state).toBe('init-failed')
    expect(consented.reason).toBe('not initialized')
  })

  it('is unavailable when initialization failed', () => {
    const failed = mcp(remote, {
      consented: new Set(['docs']),
      initialized: new Set(['docs']),
      initFailed: new Map([['docs', 'handshake timed out']]),
    })

    expect(failed.state).toBe('init-failed')
    expect(failed.reason).toContain('handshake')
  })

  it('is active once consented and initialized', () => {
    const ok = mcp(remote, {
      consented: new Set(['docs']),
      initialized: new Set(['docs']),
    })

    expect(ok.state).toBe('active')
  })

  it('refuses a transport it cannot represent', () => {
    const result = mcp({ ...remote, transport: 'websocket' })

    expect(result.state).toBe('unsupported')
    expect(result.reason).toContain('websocket')
  })

  /**
   * Structured argv, never a command string. A path with a space, a quote, or
   * a name that looks like a flag is data; joining it into a command line is
   * what turns that data into arguments someone else chose.
   */
  it('keeps arguments as argv, including hostile-looking ones', () => {
    const config = toJanMcpConfig({
      ...local,
      args: [
        '/home/dev/my repo/server.js',
        '--root="/home/dev/note-py"',
        '--flag',
        'naïve—arg',
        '; rm -rf /',
      ],
    })

    expect(config?.args).toEqual([
      '/home/dev/my repo/server.js',
      '--root="/home/dev/note-py"',
      '--flag',
      'naïve—arg',
      '; rm -rf /',
    ])
    expect(config?.command).toBe('npx')
  })

  /**
   * The filesystem server refuses any path not on its own argv, so the folders
   * the session attached have to be named on the command line as well as
   * permitted by the sandbox. Detected by argv, never by the entry's name.
   */
  it('appends the attached folders to a filesystem server argv', () => {
    const confinement = {
      workspace: '/jan/sessions/session-a',
      repository: ROOT,
      readRoots: ['/home/dev/attached-notes'],
      allowedEnv: [],
    }
    const config = toJanMcpConfig(
      { ...local, args: ['-y', FILESYSTEM_SERVER_PACKAGE] },
      confinement
    )

    expect(config?.args).toEqual([
      '-y',
      FILESYSTEM_SERVER_PACKAGE,
      '/jan/sessions/session-a',
      ROOT,
      '/home/dev/attached-notes',
    ])
  })

  it('does not append a folder a filesystem server already names', () => {
    const confinement = {
      workspace: '/jan/sessions/session-a',
      repository: ROOT,
      allowedEnv: [],
    }
    const config = toJanMcpConfig(
      { ...local, args: ['-y', FILESYSTEM_SERVER_PACKAGE, ROOT] },
      confinement
    )

    // ROOT is already present and is not duplicated; only the workspace is added.
    expect(config?.args).toEqual([
      '-y',
      FILESYSTEM_SERVER_PACKAGE,
      ROOT,
      '/jan/sessions/session-a',
    ])
  })

  it('leaves a non-filesystem server argv untouched', () => {
    const confinement = {
      workspace: '/jan/sessions/session-a',
      repository: ROOT,
      allowedEnv: [],
    }
    const config = toJanMcpConfig(
      { ...local, args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
      confinement
    )

    expect(config?.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-sequential-thinking',
    ])
  })

  it('detects the filesystem server by argv, including a pinned version', () => {
    expect(isFilesystemServer(['-y', FILESYSTEM_SERVER_PACKAGE])).toBe(true)
    expect(isFilesystemServer(['-y', `${FILESYSTEM_SERVER_PACKAGE}@2025.1.0`])).toBe(true)
    expect(isFilesystemServer(['-y', '@browsermcp/mcp'])).toBe(false)
  })

  it('gathers the allowed dirs in stable order without duplicates', () => {
    expect(
      filesystemAllowedDirs({
        workspace: '/ws',
        repository: '/ws',
        readRoots: ['/extra', '/ws'],
        allowedEnv: [],
      })
    ).toEqual(['/ws', '/extra'])
  })

  // Values never travel here. The user supplies them through Jan's own
  // handling, and the manifest carries names so they can see what is asked for.
  it('carries environment variable names and never their values', () => {
    const config = toJanMcpConfig(local)
    const active = mcp(local, {
      confinement: { stdio: true },
      consented: new Set(['files']),
      initialized: new Set(['files']),
    })

    expect(config?.env).toEqual({})
    expect(active.dependencies).toEqual(['API_TOKEN'])
    expect(JSON.stringify(active)).not.toContain('secret')
  })

  it('reports a stdio definition with no command as malformed', () => {
    expect(mcp({ ...local, command: null }).state).toBe('malformed')
  })
})

describe('commands, hooks and plugins', () => {
  it.each(['command', 'hook', 'plugin'] as const)(
    'lists a %s without running it',
    (type) => {
      const result = classifyInert({
        name: 'pre-commit',
        type,
        path: `${ROOT}/.claude/${type}s/pre-commit`,
        source: 'project',
      })

      expect(result.state).toBe('unsupported')
      expect(result.enabled).toBe(false)
    }
  )

  // A partly usable plugin is worth more than a rejected one, as long as the
  // split is visible.
  it('separates a plugin’s usable parts from the plugin itself', () => {
    const result = classifyInert({
      name: 'toolkit',
      type: 'plugin',
      path: `${ROOT}/.claude/plugins/toolkit`,
      source: 'plugin',
      parts: ['skill:reviewer', 'agent:auditor'],
    })

    expect(result.state).toBe('unsupported')
    expect(result.dependencies).toEqual(['skill:reviewer', 'agent:auditor'])
  })
})

describe('the resolved manifest', () => {
  it('claims nothing while compatibility is off', () => {
    const manifest = resolveCompatibility(
      probes({
        instructions: [
          { name: 'CLAUDE.md', path: `${ROOT}/CLAUDE.md`, content: 'x' },
        ],
      }),
      options({ enabled: false })
    )

    expect(manifest.enabled).toBe(false)
    expect(manifest.components.every((one) => one.state !== 'active')).toBe(
      true
    )
    expect(compatInstructionBlocks(manifest)).toEqual([])
  })

  it('reports a duplicate skill name rather than letting one shadow the other', () => {
    const manifest = resolveCompatibility(
      probes({
        skills: [
          {
            name: 'reviewer',
            dir: `${ROOT}/.claude/skills/reviewer`,
            source: 'project',
            frontmatter: {},
            content: 'first',
          },
          {
            name: 'reviewer',
            dir: `${ROOT}/.claude/skills/reviewer-2`,
            source: 'project',
            frontmatter: {},
            content: 'second',
          },
        ],
      }),
      options({ enabledSkills: new Set(['reviewer']) })
    )

    const states = manifest.components.map((one) => one.state)
    expect(states).toEqual(['active', 'duplicate'])
    expect(manifest.components[1].content).toBeUndefined()
  })

  it('reports a duplicate MCP name rather than racing them', () => {
    const one = {
      name: 'docs',
      source: 'project' as const,
      path: `${ROOT}/.mcp.json`,
      transport: 'http' as const,
      url: 'https://a.test/mcp',
    }
    const manifest = resolveCompatibility(
      probes({ mcp: [one, { ...one, url: 'https://b.test/mcp' }] }),
      options()
    )

    expect(manifest.components[1].state).toBe('duplicate')
  })

  // A scan for the previous folder resolving after the user attached another
  // must not activate anything against the new one.
  it('is only valid for the binding it was resolved against', () => {
    const manifest = resolveCompatibility(probes(), options())

    expect(manifestMatches(manifest, binding)).toBe(true)
    expect(
      manifestMatches(manifest, { sessionId: SESSION, folder: SIBLING })
    ).toBe(false)
    expect(
      manifestMatches(manifest, { sessionId: 'other', folder: ROOT })
    ).toBe(false)
  })

  it('gives an unattached session nothing to activate', () => {
    const manifest = emptyManifest({ sessionId: SESSION, folder: null })

    expect(manifest.enabled).toBe(false)
    expect(manifest.components).toEqual([])
  })

  // The whole manifest, in one repository, with every kind of component.
  it('describes a whole repository without activating anything unsafe', () => {
    const manifest = resolveCompatibility(
      probes({
        instructions: [
          {
            name: 'CLAUDE.md',
            path: `${ROOT}/CLAUDE.md`,
            content: 'Be brief.',
          },
        ],
        skills: [
          {
            name: 'reviewer',
            dir: `${ROOT}/.claude/skills/reviewer`,
            source: 'project',
            frontmatter: {},
            content: 'Review.',
          },
        ],
        agents: [
          {
            name: 'auditor',
            path: `${ROOT}/.claude/agents/auditor.md`,
            content: 'Audit.',
            tools: ['read'],
          },
        ],
        mcp: [
          {
            name: 'files',
            source: 'project',
            path: `${ROOT}/.mcp.json`,
            transport: 'stdio',
            command: 'npx',
            args: ['server'],
          },
        ],
        inert: [
          {
            name: 'pre-commit',
            type: 'hook',
            path: `${ROOT}/.claude/hooks/pre-commit`,
            source: 'project',
          },
        ],
      }),
      options({ enabledSkills: new Set(['reviewer']) })
    )

    expect(
      Object.fromEntries(manifest.components.map((c) => [c.type, c.state]))
    ).toEqual({
      instructions: 'active',
      skill: 'active',
      agent: 'active',
      // The local server is the one thing that stays off, and says why.
      mcp: 'unsupported-confinement',
      hook: 'unsupported',
    })
  })

  // Nothing here is authority-bearing, and nothing here is a secret.
  it('carries no grant id or secret in anything it produces', () => {
    const manifest = resolveCompatibility(
      probes({
        mcp: [
          {
            name: 'docs',
            source: 'project',
            path: `${ROOT}/.mcp.json`,
            transport: 'http',
            url: 'https://example.test/mcp',
            envNames: ['API_TOKEN'],
          },
        ],
      }),
      options()
    )

    const serialized = JSON.stringify(manifest)
    expect(serialized).not.toMatch(/grant/i)
    expect(serialized).toContain('API_TOKEN')
  })
})

describe('imported agents, as things the run can dispatch', () => {
  const manifestWith = (
    components: CompatComponent[]
  ): CompatibilityManifest => ({
    binding: { sessionId: 's1', folder: ROOT },
    enabled: true,
    components,
    scannedAt: 1,
  })

  const active = (name: string): CompatComponent => ({
    id: `agent:${name}`,
    type: 'agent',
    name,
    source: 'project',
    path: `${ROOT}/.claude/agents/${name}.md`,
    enabled: true,
    state: 'active',
    description: 'reviews the parser',
    dependencies: ['read', 'grep'],
    content: 'You review parsers.',
  })

  it('turns an active agent into a definition the task tool can run', () => {
    const { definitions } = importedAgents(
      manifestWith([active('reviewer')]),
      []
    )

    expect(definitions).toEqual([
      {
        name: 'reviewer',
        description: 'reviews the parser',
        system_prompt: 'You review parsers.',
        // Already intersected at classification; null would mean "everything
        // the parent has", which a definition naming tools did not ask for.
        allowed_tools: ['read', 'grep'],
        // Never the model the file named: choosing a model is the user's.
        model: null,
      },
    ])
  })

  it('offers nothing for an agent Jan refused', () => {
    // A request for it must fail as unknown rather than launch something that
    // is not what the repository described.
    const refused: CompatComponent = {
      ...active('escaper'),
      state: 'path-escape',
      content: undefined,
    }
    expect(importedAgents(manifestWith([refused]), []).definitions).toEqual([])
  })

  it('lets a saved definition keep its name', () => {
    const { definitions, shadowed } = importedAgents(
      manifestWith([active('reviewer')]),
      [{ name: 'reviewer' }]
    )

    expect(definitions).toEqual([])
    expect(shadowed).toEqual(['reviewer'])
  })
})
