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
    ['Library', 'settings-chat-html-artifacts'],
    ['enter newline', 'settings-chat-enter-newline'],
    ['factory reset', 'settings-data-factory-reset'],
    ['logs', 'settings-data-logs'],
  ])('%s', (query, id) => {
    const first = searchSettings(index(), query)[0]
    expect(first?.id.startsWith(id)).toBe(true)
    expect(first?.kind).toBe('setting')
  })

  it.each(['backup', 'factory reset', 'logs'])('%s opens the Data page', (query) => {
    const [first] = searchSettings(index(), query)
    expect(first?.route).toContain('/settings/data')
  })

  it('ranks Agent Tools first for compaction, with an anchor to scroll to', () => {
    const [first] = searchSettings(index(), 'compaction')
    expect(first.route).toContain('/settings/agent')
    expect(first.anchor).toBeTruthy()
  })
})
