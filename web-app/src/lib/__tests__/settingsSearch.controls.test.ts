import { describe, it, expect, vi } from 'vitest'
// The desktop app, where every settings page exists.
vi.mock('@/lib/platform/utils', async (orig) => ({
  ...((await orig()) as object),
  isPlatformTauri: () => true,
}))
import { buildSettingsIndex, searchSettings } from '../settingsSearch'
import i18n from '@/i18n'

const index = () => buildSettingsIndex((k: string) => i18n.t(k))

describe('settings search finds controls, not only pages', () => {
  it.each([
    ['Trusted folders', 'settings-permissions-trusted-folders'],
    ['tool timeout', 'settings-mcp-servers-'],
    ['compaction', 'settings-agent-tools-compaction'],
    ['Library', 'settings-appearance-html-artifacts'],
  ])('%s', (query, id) => {
    const first = searchSettings(index(), query)[0]
    expect(first?.id.startsWith(id)).toBe(true)
    expect(first?.kind).toBe('setting')
  })

  it('ranks Agent Tools first for compaction, with an anchor to scroll to', () => {
    const [first] = searchSettings(index(), 'compaction')
    expect(first.route).toContain('agent-tools')
    expect(first.anchor).toBeTruthy()
  })
})
