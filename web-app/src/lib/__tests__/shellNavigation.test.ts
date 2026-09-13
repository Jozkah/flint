import { describe, expect, it } from 'vitest'
import { RAIL_ITEMS, areaForPath, isSettingsArea } from '../shellNavigation'

describe('areaForPath', () => {
  it.each([
    ['/', 'workspace'],
    ['/threads/abc', 'workspace'],
    ['/project/p1', 'workspace'],
    ['/cowork', 'workspace'],
    ['/artifacts', 'library'],
    ['/settings/providers', 'models'],
    ['/settings/providers/llama.cpp', 'models'],
    ['/settings/hardware', 'models'],
    ['/settings/mcp-servers', 'tools'],
    ['/settings/agent-tools', 'tools'],
    ['/settings/web-search', 'tools'],
    ['/settings/extensions', 'tools'],
    ['/settings/claude-code', 'tools'],
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
  })
})

describe('RAIL_ITEMS', () => {
  it('has the four work areas on top and search, system and settings below', () => {
    expect(RAIL_ITEMS.filter((i) => i.group === 'top').map((i) => i.id)).toEqual([
      'workspace',
      'library',
      'models',
      'tools',
    ])
    expect(RAIL_ITEMS.filter((i) => i.group === 'bottom').map((i) => i.id)).toEqual([
      'search',
      'system',
      'settings',
    ])
  })

  it('opens a route for every item except Search, and each route maps back to its item', () => {
    for (const item of RAIL_ITEMS) {
      if (item.id === 'search') {
        expect(item.to).toBeUndefined()
        continue
      }
      expect(areaForPath(item.to!)).toBe(item.id)
    }
  })

  it('uses the settings navigation for models, tools and settings only', () => {
    expect(isSettingsArea('models')).toBe(true)
    expect(isSettingsArea('tools')).toBe(true)
    expect(isSettingsArea('settings')).toBe(true)
    expect(isSettingsArea('workspace')).toBe(false)
    expect(isSettingsArea('library')).toBe(false)
  })
})
