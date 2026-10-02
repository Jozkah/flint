import { describe, expect, it } from 'vitest'
import { areaForPath, showsSettingsSections } from '../shellNavigation'

describe('areaForPath', () => {
  it.each([
    ['/', 'workspace'],
    ['/threads/abc', 'workspace'],
    ['/project/p1', 'workspace'],
    ['/cowork', 'workspace'],
    ['/rooms', 'rooms'],
    ['/rooms/room-1', 'rooms'],
    ['/artifacts', 'library'],
    ['/extensions', 'extensions'],
    ['/settings/providers', 'models'],
    ['/settings/providers/llama.cpp', 'models'],
    ['/settings/hardware', 'settings'],
    ['/settings/mcp-servers', 'tools'],
    ['/settings/agent-tools', 'settings'],
    ['/settings/web-search', 'settings'],
    ['/settings/extensions', 'settings'],
    ['/settings/claude-code', 'settings'],
    ['/system-monitor', 'system'],
    ['/logs', 'system'],
    ['/local-api-server/logs', 'system'],
    ['/settings/general', 'settings'],
    ['/settings/interface', 'settings'],
    ['/settings/local-api-server', 'settings'],
    ['/settings/memory/', 'settings'],
  ])('%s is %s', (path, area) => {
    expect(areaForPath(path)).toBe(area)
  })

  it('does not treat a prefix of another word as the same page', () => {
    expect(areaForPath('/settings/providers-extra')).toBe('settings')
    expect(areaForPath('/artifactsx')).toBe('workspace')
    expect(areaForPath('/roomsx')).toBe('workspace')
  })
})

describe('showsSettingsSections', () => {
  it('keeps the Sections list on every page it links to, MCP servers included', () => {
    for (const path of ['/settings/general', '/settings/mcp-servers', '/settings/extensions', '/settings/jev', '/settings/mcp-servers/', '/settings/providers', '/settings/providers/openai']) {
      expect(showsSettingsSections(path)).toBe(true)
    }
  })

  it('shows none in the Models area or outside settings', () => {
    for (const path of ['/hub', '/', '/studio']) {
      expect(showsSettingsSections(path)).toBe(false)
    }
  })
})
