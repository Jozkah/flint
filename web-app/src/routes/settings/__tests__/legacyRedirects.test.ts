import { describe, expect, it } from 'vitest'
import { isRedirect } from '@tanstack/react-router'
import { Route as InterfaceRoute } from '../interface'
import { Route as HttpsProxyRoute } from '../https-proxy'
import { Route as AgentToolsRoute } from '../agent-tools'
import { Route as ClaudeCodeRoute } from '../claude-code'
import { Route as JevRoute } from '../jev'
import { Route as ExtensionsRoute } from '../extensions'

// Old links, bookmarks and saved routes keep working after a page is renamed.
const redirectOf = (r: { options: { beforeLoad?: unknown } }) => {
  try {
    ;(r.options.beforeLoad as (ctx: { search: object }) => void)({ search: {} })
  } catch (e) {
    return e
  }
  return undefined
}

describe('legacy settings routes', () => {
  it.each([
    ['/settings/interface', InterfaceRoute, '/settings/appearance'],
    ['/settings/https-proxy', HttpsProxyRoute, '/settings/network-proxy'],
    ['/settings/agent-tools', AgentToolsRoute, '/settings/agent'],
  ])('%s redirects to %s', (_from, r, to) => {
    const thrown = redirectOf(r as never)
    expect(isRedirect(thrown)).toBe(true)
    expect((thrown as { options: { to: string } }).options.to).toBe(to)
  })

  it.each([
    ['/settings/claude-code', ClaudeCodeRoute, 'claude-code'],
    ['/settings/jev', JevRoute, 'jev'],
    ['/settings/extensions', ExtensionsRoute, 'extensions'],
  ])('%s opens the %s tab of Integrations', (_from, r, tab) => {
    const thrown = redirectOf(r as never)
    expect(isRedirect(thrown)).toBe(true)
    const { options } = thrown as { options: { to: string; search: object } }
    expect(options.to).toBe('/settings/integrations')
    expect(options.search).toEqual({ tab })
  })
})
