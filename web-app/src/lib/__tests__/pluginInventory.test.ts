import { describe, it, expect, vi, beforeEach } from 'vitest'

// `invoke` stands in for the agent_plugin_* Tauri commands: the inventory must
// come from Flint's plugin state, never from files it guesses at.
const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

import {
  listPluginsForModel,
  pluginInventoryLine,
  readPluginInventory,
  setCachedPluginInventory,
} from '../pluginInventory'

const caveman = {
  id: 'caveman',
  name: 'caveman',
  description: 'Talk like caveman',
  version: '1.2.0',
  repo: '',
  skills: 3,
  commands: 1,
  agents: 0,
  enabled: true,
  sourceKind: 'git',
  source: 'https://github.com/JuliusBrussee/caveman',
}
const off = { ...caveman, id: 'quiet', name: 'quiet', enabled: false, sourceKind: null, source: null }

function plugins(global: unknown[], project: unknown[] = []) {
  invoke.mockImplementation((cmd: string, args: any) => {
    if (cmd === 'agent_plugin_list') {
      return Promise.resolve(args.scope === 'global' ? global : project)
    }
    if (cmd === 'agent_plugin_details') {
      return Promise.resolve({
        skillNames: args.id === 'caveman' ? ['caveman', 'caveman-commit', 'caveman-review'] : [],
        commandNames: args.id === 'caveman' ? ['/caveman'] : [],
        agentNames: [],
        hasMcpConfig: false,
      })
    }
    return Promise.reject(new Error(`unexpected ${cmd}`))
  })
}

describe('plugin inventory', () => {
  beforeEach(() => {
    invoke.mockReset()
    setCachedPluginInventory(null)
  })

  it('reports installed plugins with state, source, version and skills', async () => {
    plugins([caveman, off])
    const out = JSON.parse(await listPluginsForModel())
    expect(out.count).toBe(2)
    const c = out.plugins.find((p: any) => p.id === 'caveman')
    expect(c).toMatchObject({
      enabled: true,
      scope: 'global',
      version: '1.2.0',
      source: { kind: 'git', location: 'https://github.com/JuliusBrussee/caveman' },
      skills: ['caveman', 'caveman-commit', 'caveman-review'],
      commands: ['/caveman'],
    })
    expect(out.plugins.find((p: any) => p.id === 'quiet').enabled).toBe(false)
    // Read through the plugin commands only.
    for (const [cmd] of invoke.mock.calls) {
      expect(cmd).toMatch(/^agent_plugin_(list|details)$/)
    }
  })

  it('says so when nothing is installed', async () => {
    plugins([])
    const out = JSON.parse(await listPluginsForModel())
    expect(out.count).toBe(0)
    expect(out.note).toBe('No plugins are installed.')
    expect(pluginInventoryLine()).toContain('No Flint plugins are installed.')
  })

  it("includes the attached project's own plugins", async () => {
    plugins([caveman], [{ ...off, id: 'proj', name: 'proj', enabled: true }])
    const inv = await readPluginInventory('D:/repo')
    expect(inv.plugins.map((p) => `${p.scope}:${p.id}`)).toEqual([
      'global:caveman',
      'project:proj',
    ])
  })

  it('reports an unreadable scope instead of guessing', async () => {
    invoke.mockRejectedValue({ code: 'io', message: 'denied' })
    const out = JSON.parse(await listPluginsForModel())
    expect(out.count).toBe(0)
    expect(out.unreadable).toHaveLength(1)
    expect(out.note).toBeUndefined()
  })

  it('names enabled plugins and their skills in the prompt line, and lists disabled ones apart', async () => {
    plugins([caveman, off])
    await readPluginInventory()
    const line = pluginInventoryLine()
    expect(line).toContain('Enabled Flint plugins: caveman (skills: caveman, caveman-commit, caveman-review)')
    expect(line).toContain('Installed but disabled: quiet.')
    expect(line).toMatch(/never search the filesystem for plugin settings/)
  })

  it('says nothing before the inventory has been read', () => {
    expect(pluginInventoryLine()).toBe('')
  })
})
