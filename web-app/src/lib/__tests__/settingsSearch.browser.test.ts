import { describe, expect, it, vi } from 'vitest'

// The browser build served by `flint serve`: no Tauri bridge.
vi.mock('@/lib/platform/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/utils')>()),
  isPlatformTauri: () => false,
}))

import {
  buildSettingsIndex,
  isSettingsPageAvailable,
} from '@/lib/settingsSearch'

const DESKTOP_ONLY = [
  'local-api-server',
  'remote-access',
  'https-proxy',
  'schedules',
]

describe('settings in a plain browser', () => {
  it('leaves desktop-only pages out of the menu and search', () => {
    for (const id of DESKTOP_ONLY) expect(isSettingsPageAvailable(id)).toBe(false)
    expect(isSettingsPageAvailable('general')).toBe(true)
    expect(isSettingsPageAvailable('web-search')).toBe(true)
    const index = buildSettingsIndex((k) => k)
    const ids = index.map((e) => e.id)
    for (const id of DESKTOP_ONLY) expect(ids).not.toContain(`page-${id}`)
    expect(ids).toContain('page-general')
    expect(
      index.some((e) => e.kind === 'setting' && e.route.includes('local-api-server'))
    ).toBe(false)
  })

  it('keeps Integrations for its Jev tab, without the Claude Code settings', () => {
    expect(isSettingsPageAvailable('integrations')).toBe(true)
    const ids = buildSettingsIndex((k) => k).map((e) => e.id)
    expect(ids).toContain('page-integrations')
    expect(ids).toContain('settings-integrations-jev-key')
    expect(ids.some((id) => id.startsWith('settings-integrations-claude-code-'))).toBe(false)
  })
})
