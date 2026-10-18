import { describe, expect, it } from 'vitest'
import fixture from './fixtures/unrouted-commands.json'
import { serverRoutes, unroutedCommands } from '../../../scripts/web-command-inventory'
import { DESKTOP_ONLY_COMMANDS } from '@/lib/desktopOnlyCommands'

describe('web-mode command inventory', () => {
  const unrouted = unroutedCommands()
  const routes = serverRoutes()

  it('reads both sides', () => {
    // Guards against the scanners silently finding nothing.
    for (const r of ['agent_list_folders', 'rooms_list', 'agent_git_status', 'folder_trust_status']) {
      expect(routes.has(r), r).toBe(true)
    }
    expect(Object.keys(unrouted).length).toBeGreaterThan(100)
  })

  it('lists every command the app calls without a server route as desktop-only', () => {
    const unlisted = Object.keys(unrouted).filter((c) => !DESKTOP_ONLY_COMMANDS.has(c))
    // Route it in flint serve, or add it to desktopOnlyCommands.ts with a reason.
    expect(unlisted).toEqual([])
  })

  it('lists no command the server routes, or one nothing calls', () => {
    const stale = [...DESKTOP_ONLY_COMMANDS.keys()].filter((c) => routes.has(c) || !(c in unrouted))
    expect(stale).toEqual([])
  })

  it('keeps the committed inventory current', () => {
    // `node scripts/web-command-inventory.ts --write` refreshes it.
    expect(Object.keys(fixture).sort()).toEqual(Object.keys(unrouted).sort())
  })
})
