import { beforeEach, describe, expect, it, vi } from 'vitest'

const advertisedToolSchemas = vi.fn()
const executeTool = vi.fn()
const threadWorkspaceDelete = vi.fn()
const threadWorkspaceSweep = vi.fn()
const sandboxStatus = vi.fn()
const getJanDataFolder = vi.fn()

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  advertisedToolSchemas: (...args: unknown[]) => advertisedToolSchemas(...args),
  executeTool: (...args: unknown[]) => executeTool(...args),
  threadWorkspaceDelete: (...args: unknown[]) => threadWorkspaceDelete(...args),
  threadWorkspaceSweep: (...args: unknown[]) => threadWorkspaceSweep(...args),
  sandboxStatus: () => sandboxStatus(),
}))

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder }) }),
}))

const schemaFor = (name: string) => ({
  type: 'function' as const,
  function: { name, description: `${name} desc`, parameters: {} },
})

/**
 * What the backend answers. The environment decides which tools exist, so a
 * test that wants `bash` withheld says so the way production does -- by having
 * the backend omit it with a reason -- rather than by faking a sandbox probe.
 */
const advertising = (
  schemas: string[],
  omitted: { name: string; component?: string; reason?: string }[] = []
) => ({
  schemas: schemas.map(schemaFor),
  omitted: omitted.map((o) => ({
    name: o.name,
    component: o.component ?? 'sandbox',
    reason: o.reason ?? 'sandbox-unavailable',
    message: o.name + ' needs something this machine does not have.',
  })),
})

describe('agentTools', () => {
  beforeEach(() => {
    vi.resetModules()
    advertisedToolSchemas.mockReset()
    executeTool.mockReset()
    threadWorkspaceDelete.mockReset().mockResolvedValue(undefined)
    threadWorkspaceSweep.mockReset().mockResolvedValue(0)
    sandboxStatus
      .mockReset()
      .mockResolvedValue({ backend: 'bubblewrap', enforces: true })
    getJanDataFolder.mockReset().mockResolvedValue('/data')
  })

  /// The list depends on the folder it was computed for. One module-level
  /// cache shared by chat and Cowork let whichever surface asked first decide
  /// the tool set for every later caller -- a folderless chat's answer served
  /// to a Cowork session with a folder, for the life of the page.
  it('does not serve the tool list of one folder to another', async () => {
    advertisedToolSchemas.mockImplementation(async (projectRoot?: string) =>
      projectRoot
        ? advertising(['read', 'ls', 'write'])
        : advertising(
            [],
            [
              {
                name: 'ls',
                component: 'filesystem',
                reason: 'workspace-unattached',
              },
            ]
          )
    )
    const { getAgentToolSchemas } = await import('../agentTools')

    const without = await getAgentToolSchemas()
    expect(without.map((s) => s.function.name)).not.toContain('ls')

    const withFolder = await getAgentToolSchemas('/proj')
    expect(withFolder.map((s) => s.function.name)).toContain('ls')
    expect(advertisedToolSchemas).toHaveBeenCalledTimes(2)

    // And the same question twice is still answered from the cache.
    await getAgentToolSchemas('/proj')
    expect(advertisedToolSchemas).toHaveBeenCalledTimes(2)
  })

  /// The messaging tools are offered only to the session scope, which the
  /// generated binding cannot pass, so a scoped request calls the plugin
  /// command itself -- and is cached apart from the thread list.
  it('passes the session scope to the backend and caches it apart from threads', async () => {
    const messaging = ['list_sessions', 'send_message', 'read_messages', 'wait_for_reply']
    advertisedToolSchemas.mockResolvedValue(advertising(['read']))
    invoke.mockReset().mockResolvedValue(advertising(['read', ...messaging]))
    const { getAgentToolSchemas } = await import('../agentTools')

    const thread = (await getAgentToolSchemas('/p')).map((s) => s.function.name)
    expect(thread).toEqual(['read'])
    expect(invoke).not.toHaveBeenCalled()

    const session = (await getAgentToolSchemas('/p', undefined, 'session' as never)).map(
      (s) => s.function.name
    )
    expect(session).toEqual(['read', ...messaging])
    expect(invoke).toHaveBeenCalledWith('plugin:agent-tools|advertised_tool_schemas', {
      projectRoot: '/p',
      reported: undefined,
      scope: 'session',
    })
  })

  it('advertises the workspace tools including writes and bash', async () => {
    const { AGENT_TOOL_NAMES } = await import('../agentTools')
    for (const name of ['read', 'ls', 'find', 'grep', 'bash']) {
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true)
    }
    // write/edit can only touch the thread's ephemeral sandbox, so they are
    // allowed there without a prompt -- withholding them while bash can write
    // the same files would be a restriction a sibling tool bypasses.
    for (const name of ['write', 'edit']) {
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true)
    }
    // Already advertised through the websearch plugin.
    for (const name of ['web_search', 'web_fetch']) {
      expect(AGENT_TOOL_NAMES.has(name)).toBe(false)
    }
  })

  it('filters the backend list down to the tools this surface dispatches', async () => {
    advertisedToolSchemas.mockResolvedValue(
      advertising(['read', 'write', 'memory_write', 'web_search'])
    )
    const { getAgentToolSchemas } = await import('../agentTools')
    const names = (await getAgentToolSchemas()).map((s) => s.function.name)
    // `web_search` is advertised through the websearch plugin instead, so it
    // is dropped here even though the environment allows it.
    expect(names).toEqual(['read', 'write', 'memory_write'])
  })

  it('probes readiness for the project the tools will work in', async () => {
    advertisedToolSchemas.mockResolvedValue(advertising(['read']))
    const { getAgentToolSchemas } = await import('../agentTools')
    const reported = [
      {
        component: 'model',
        state: 'ready',
        reason: 'ok',
        message: 'fine',
        checkedAtMs: 1,
        retryable: false,
        capabilities: ['model.dispatch'],
        details: [],
      },
    ]
    await getAgentToolSchemas('/proj', reported as never)
    expect(advertisedToolSchemas).toHaveBeenCalledWith('/proj', reported)
  })

  /// The diff must reach the caller so the UI can render it, but stay out of
  /// `content`, which is what gets sent back to the model.
  it('returns the diff alongside content, not inside it', async () => {
    executeTool.mockResolvedValue({
      content: 'Applied 1 edit(s) to a.txt',
      diff: '@@ edit 1/1 @@\n-    1 | a\n+    1 | A',
      isError: false,
    })
    const { executeAgentTool } = await import('../agentTools')
    const result = await executeAgentTool('edit', { path: 'a.txt' }, 'thread-1')
    expect(result.content).toBe('Applied 1 edit(s) to a.txt')
    expect(result.diff).toContain('+    1 | A')
    expect(String(result.content)).not.toContain('@@')
  })

  it('omits the diff for tools that produce none', async () => {
    executeTool.mockResolvedValue({
      content: 'a.txt',
      diff: null,
      isError: false,
    })
    const { executeAgentTool } = await import('../agentTools')
    const result = await executeAgentTool('ls', {}, 'thread-1')
    expect(result.diff).toBeUndefined()
  })

  it('offers bash when the environment can run it', async () => {
    advertisedToolSchemas.mockResolvedValue(advertising(['read', 'bash']))
    const { getAgentToolSchemas } = await import('../agentTools')
    const names = (await getAgentToolSchemas()).map((s) => s.function.name)
    expect(names).toEqual(['read', 'bash'])
  })

  // Offering a tool the executor will always refuse wastes a model turn, so an
  // unconfinable host must not see bash at all.
  it('withholds bash when the environment cannot run it', async () => {
    advertisedToolSchemas.mockResolvedValue(
      advertising(['read'], [{ name: 'bash' }])
    )
    const { getAgentToolSchemas } = await import('../agentTools')
    const names = (await getAgentToolSchemas()).map((s) => s.function.name)
    expect(names).toEqual(['read'])
  })

  // A shell that cannot start must cost the session its shell tool and nothing
  // else. This is the whole point of per-component readiness.
  it('keeps the file tools when the shell is the thing that failed', async () => {
    advertisedToolSchemas.mockResolvedValue(
      advertising(
        ['read', 'ls', 'grep', 'write', 'edit'],
        [
          {
            name: 'bash',
            component: 'shell',
            reason: 'shell-runtime-incompatible',
          },
        ]
      )
    )
    const { getAgentToolSchemas, omittedAgentTools } = await import(
      '../agentTools'
    )
    const names = (await getAgentToolSchemas()).map((s) => s.function.name)
    expect(names).toEqual(['read', 'ls', 'grep', 'write', 'edit'])
    // The reason is kept, so a tool that vanished stays distinguishable from a
    // bug.
    expect(omittedAgentTools()).toEqual([
      expect.objectContaining({
        name: 'bash',
        component: 'shell',
        reason: 'shell-runtime-incompatible',
      }),
    ])
  })

  it('keeps the previous list when the readiness call itself fails', async () => {
    advertisedToolSchemas.mockRejectedValue(new Error('probe exploded'))
    const { getAgentToolSchemas } = await import('../agentTools')
    // An empty tool set would silently turn an agent into a chatbot, so a
    // transport failure withholds nothing beyond what is already withheld.
    expect(await getAgentToolSchemas()).toEqual([])
    expect(advertisedToolSchemas).toHaveBeenCalled()
  })

  // Installing a backend, fixing a permission or attaching a folder has to
  // reach the next dispatch without restarting the session.
  it('rebuilds the list after a readiness refresh', async () => {
    advertisedToolSchemas.mockResolvedValue(
      advertising(['read'], [{ name: 'bash' }])
    )
    const { getAgentToolSchemas, refreshSandboxStatus } = await import(
      '../agentTools'
    )
    expect((await getAgentToolSchemas()).map((s) => s.function.name)).toEqual([
      'read',
    ])

    advertisedToolSchemas.mockResolvedValue(advertising(['read', 'bash']))
    // Without the refresh the cache would keep serving the old answer.
    expect((await getAgentToolSchemas()).map((s) => s.function.name)).toEqual([
      'read',
    ])
    await refreshSandboxStatus()
    expect((await getAgentToolSchemas()).map((s) => s.function.name)).toEqual([
      'read',
      'bash',
    ])
  })

  it('still reports the sandbox backend for the system prompt', async () => {
    sandboxStatus.mockRejectedValue(new Error('probe exploded'))
    advertisedToolSchemas.mockResolvedValue(advertising(['read']))
    const { getAgentToolSchemas, sandboxEnforces } = await import(
      '../agentTools'
    )
    await getAgentToolSchemas()
    expect(sandboxEnforces()).toBe(false)
  })

  /// AH-202: the run id is what the backend journals a turn's file changes
  /// under. Dropped here, nothing could ever be undone.
  it('forwards the run a call belongs to, for undo', async () => {
    executeTool.mockResolvedValue({ content: '', diff: null, isError: false })
    const { executeAgentTool } = await import('../agentTools')
    await executeAgentTool('write', { path: 'a.txt' }, 'session-1', {
      scope: 'session',
      undoRun: 'run-7',
    })
    const call = executeTool.mock.calls.at(-1) as unknown[]
    expect(call[9]).toBe('session')
    expect(call[11]).toBe('run-7')
  })

  it('passes the network setting through to the plugin', async () => {
    executeTool.mockResolvedValue({ content: '', diff: null, isError: false })
    const { useAgentToolsConfig } = await import('@/hooks/useAgentToolsConfig')
    const { executeAgentTool } = await import('../agentTools')

    await executeAgentTool('bash', { command: 'ls' }, 'thread-1')
    expect(executeTool).toHaveBeenLastCalledWith(
      '/data',
      'thread-1',
      'bash',
      { command: 'ls' },
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'thread',
      undefined,
      undefined,
      undefined
    )

    useAgentToolsConfig.getState().setBashNetworkEnabled(true)
    await executeAgentTool('bash', { command: 'ls' }, 'thread-1')
    expect(executeTool).toHaveBeenLastCalledWith(
      '/data',
      'thread-1',
      'bash',
      { command: 'ls' },
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      'thread',
      undefined,
      undefined,
      undefined
    )
    useAgentToolsConfig.getState().setBashNetworkEnabled(false)
  })

  it('caches the schemas so every turn does not re-cross IPC', async () => {
    // The backend probe starts a sandboxed shell, so re-asking per turn would
    // put a process launch in front of every model reply.
    advertisedToolSchemas.mockResolvedValue(advertising(['read']))
    const { getAgentToolSchemas } = await import('../agentTools')
    await getAgentToolSchemas()
    await getAgentToolSchemas()
    expect(advertisedToolSchemas).toHaveBeenCalledTimes(1)
  })

  /// The thread id scopes the sandbox, so it must reach the plugin on every
  /// call; without it two conversations would share one scratch directory.
  it('scopes execution to the calling thread and attaches no folder by default', async () => {
    executeTool.mockResolvedValue({
      content: 'hello',
      diff: null,
      isError: false,
    })
    const { executeAgentTool } = await import('../agentTools')
    await expect(
      executeAgentTool('read', { path: 'a.txt' }, 'thread-1')
    ).resolves.toEqual({ content: 'hello' })
    expect(executeTool).toHaveBeenCalledWith(
      '/data',
      'thread-1',
      'read',
      { path: 'a.txt' },
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'thread',
      undefined,
      undefined,
      undefined
    )
  })

  // The workspace UI promises "reads from <folder>", so the folder has to reach
  // the plugin; Rust is what makes it read-only.
  it('forwards an attached folder as the read-only project', async () => {
    vi.mocked(executeTool).mockResolvedValue({
      content: 'ok',
      isError: false,
      diff: null,
    } as never)
    const { executeAgentTool } = await import('../agentTools')
    await executeAgentTool('read', { path: 'a.txt' }, 'thread-1', {
      readOnlyProject: '/home/u/repo',
    })
    expect(executeTool).toHaveBeenLastCalledWith(
      '/data',
      'thread-1',
      'read',
      { path: 'a.txt' },
      undefined,
      undefined,
      false,
      '/home/u/repo',
      undefined,
      'thread',
      undefined,
      undefined,
      undefined
    )
  })

  it('sends undefined, not null, when no folder is attached', async () => {
    vi.mocked(executeTool).mockResolvedValue({
      content: 'ok',
      isError: false,
      diff: null,
    } as never)
    const { executeAgentTool } = await import('../agentTools')
    await executeAgentTool('read', { path: 'a.txt' }, 'thread-1', null)
    expect(vi.mocked(executeTool).mock.calls.at(-1)?.[7]).toBeUndefined()
  })

  it('maps a gate refusal to an error rather than content', async () => {
    executeTool.mockResolvedValue({
      content: "tool 'write' needs user approval",
      diff: null,
      isError: true,
    })
    const { executeAgentTool } = await import('../agentTools')
    await expect(executeAgentTool('write', {}, 'thread-1')).resolves.toEqual({
      error: "tool 'write' needs user approval",
    })
  })

  it('reports a rejected invoke as an error instead of throwing', async () => {
    executeTool.mockRejectedValue({ message: 'denied by policy' })
    const { executeAgentTool } = await import('../agentTools')
    await expect(executeAgentTool('read', {}, 'thread-1')).resolves.toEqual({
      error: 'denied by policy',
    })
  })

  it('errors when the data folder is unavailable', async () => {
    getJanDataFolder.mockResolvedValue(undefined)
    const { executeAgentTool } = await import('../agentTools')
    const result = await executeAgentTool('read', {}, 'thread-1')
    expect(result.error).toBeTruthy()
    expect(executeTool).not.toHaveBeenCalled()
  })

  it('coerces a non-object input to empty args', async () => {
    executeTool.mockResolvedValue({ content: '', diff: null, isError: false })
    const { executeAgentTool } = await import('../agentTools')
    await executeAgentTool('memory_list', undefined, 'thread-1')
    expect(executeTool).toHaveBeenCalledWith(
      '/data',
      'thread-1',
      'memory_list',
      {},
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'thread',
      undefined,
      undefined,
      undefined
    )
  })

  it('deletes one thread sandbox on cleanup', async () => {
    const { cleanupThreadWorkspace } = await import('../agentTools')
    await cleanupThreadWorkspace('thread-1')
    expect(threadWorkspaceDelete).toHaveBeenCalledWith('/data', 'thread-1')
  })

  /// Deleting a thread must not fail loudly over a leftover directory; the next
  /// startup sweep collects it.
  it('swallows a cleanup failure', async () => {
    threadWorkspaceDelete.mockRejectedValue({ message: 'busy' })
    const { cleanupThreadWorkspace } = await import('../agentTools')
    await expect(cleanupThreadWorkspace('thread-1')).resolves.toBeUndefined()
  })

  it('sweeps with the surviving thread ids', async () => {
    threadWorkspaceSweep.mockResolvedValue(3)
    const { sweepThreadWorkspaces } = await import('../agentTools')
    await expect(sweepThreadWorkspaces(['a', 'b'])).resolves.toBe(3)
    expect(threadWorkspaceSweep).toHaveBeenCalledWith('/data', ['a', 'b'])
  })

  it('reports zero swept when the sweep fails', async () => {
    threadWorkspaceSweep.mockRejectedValue(new Error('nope'))
    const { sweepThreadWorkspaces } = await import('../agentTools')
    await expect(sweepThreadWorkspaces(['a'])).resolves.toBe(0)
  })
})

/**
 * The backend command takes its arguments positionally through the guest
 * binding, and several of them are optional strings. `WorkspaceScope` is a
 * string union, so a scope handed to the wrong slot type-checks and is
 * silently accepted — which is exactly how the Cowork session scope once ended
 * up in the write-grant position, leaving sessions running under the thread
 * sweep that deletes their work.
 *
 * These assert the slots by name rather than trusting the order to stay right.
 */
describe('what reaches the backend command', () => {
  const PARAMS = [
    'dataFolder',
    'threadId',
    'name',
    'args',
    'project',
    'enabledSkills',
    'allowNetwork',
    'readOnlyProject',
    'writeGrant',
    'scope',
  ] as const

  const callArgs = () => {
    const args = executeTool.mock.calls.at(-1) ?? []
    return Object.fromEntries(
      PARAMS.map((name, i) => [name, args[i]])
    ) as Record<(typeof PARAMS)[number], unknown>
  }

  beforeEach(() => {
    vi.resetModules()
    executeTool.mockReset().mockResolvedValue({
      content: 'ok',
      diff: null,
      isError: false,
    })
    getJanDataFolder.mockReset().mockResolvedValue('/jan/data')
  })

  it('puts the session scope in the scope slot, not the grant slot', async () => {
    const { executeAgentTool } = await import('@/lib/agentTools')

    await executeAgentTool('read', { path: 'a' }, 's1', {
      readOnlyProject: '/repo',
      scope: 'session',
    })

    const args = callArgs()
    expect(args.scope).toBe('session')
    expect(args.writeGrant).toBeUndefined()
  })

  it('forwards a write grant in its own slot, leaving the scope intact', async () => {
    const { executeAgentTool } = await import('@/lib/agentTools')

    await executeAgentTool('write', { path: 'a', content: 'x' }, 's1', {
      readOnlyProject: '/repo',
      scope: 'session',
      writeGrant: 'grant-1',
    })

    const args = callArgs()
    expect(args.writeGrant).toBe('grant-1')
    expect(args.scope).toBe('session')
    expect(args.readOnlyProject).toBe('/repo')
    expect(args.threadId).toBe('s1')
  })

  // A run that was never authorized must send nothing at all, rather than an
  // empty string the backend would have to interpret.
  it('sends no grant when the run holds none', async () => {
    const { executeAgentTool } = await import('@/lib/agentTools')

    await executeAgentTool('write', { path: 'a' }, 's1', {
      readOnlyProject: '/repo',
      scope: 'session',
      writeGrant: null,
    })

    expect(callArgs().writeGrant).toBeUndefined()
  })
})

describe('agentTools host-answered tools', () => {
  beforeEach(() => {
    vi.resetModules()
    executeTool.mockReset()
    invoke.mockReset()
    getJanDataFolder.mockReset().mockResolvedValue('/data')
  })

  it('offers request_access and list_plugins', async () => {
    const { AGENT_TOOL_NAMES } = await import('../agentTools')
    expect(AGENT_TOOL_NAMES.has('request_access')).toBe(true)
    expect(AGENT_TOOL_NAMES.has('list_plugins')).toBe(true)
  })

  it('answers list_plugins from Flint plugin state, not the tool core', async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'agent_plugin_list' ? [] : undefined)
    )
    const { executeAgentTool } = await import('../agentTools')
    const out = await executeAgentTool('list_plugins', {}, 't1')
    expect(executeTool).not.toHaveBeenCalled()
    expect(JSON.parse(out.content as string).count).toBe(0)
    expect(invoke.mock.calls.map(([c]) => c)).toContain('agent_plugin_list')
  })

  it('routes request_access to the prompt, never straight to the tool core', async () => {
    invoke.mockResolvedValue({
      status: 'refused',
      code: 'drive_root',
      message: 'root',
      modelResult: '{"status":"refused","code":"drive_root"}',
    })
    const { executeAgentTool } = await import('../agentTools')
    const out = await executeAgentTool(
      'request_access',
      { path: 'C:/', reason: 'look' },
      't1'
    )
    expect(executeTool).not.toHaveBeenCalled()
    expect(out.error).toBeUndefined()
    expect(JSON.parse(out.content as string).code).toBe('drive_root')
    expect(invoke.mock.calls[0][0]).toBe('plugin:agent-tools|access_prepare')
  })
})
