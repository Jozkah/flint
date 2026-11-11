import { expect, it } from 'vitest'
import { builtinToolCount } from '../builtinToolCount'

it('counts only the tools that belong to no MCP server', () => {
  const servers: Record<string, string> = { gh_search: 'github', fs_read: 'files' }
  expect(
    builtinToolCount(['read', 'write', 'gh_search', 'fs_read'], (n) => servers[n])
  ).toBe(2)
  expect(builtinToolCount([], () => undefined)).toBe(0)
})
