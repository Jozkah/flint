import { describe, it, expect, vi } from 'vitest'
import { rankCommands, type PaletteCommand } from '../commandPalette'

const cmd = (
  id: string,
  title: string,
  section: PaletteCommand['section'],
  keywords?: string[]
): PaletteCommand => ({ id, title, section, keywords, run: vi.fn() })

const commands: PaletteCommand[] = [
  cmd('s-mcp', 'MCP Servers', 'settings'),
  cmd('t-1', 'Trip planning', 'threads'),
  cmd('a-new', 'New chat', 'actions', ['conversation']),
  cmd('n-cowork', 'Open Cowork', 'navigation', ['agent']),
  ...Array.from({ length: 8 }, (_, i) =>
    cmd(`t-x${i}`, `Old thread ${i}`, 'threads')
  ),
]

describe('rankCommands', () => {
  it('offers everything in section order when nothing is typed, threads capped', () => {
    const out = rankCommands(commands, '')
    expect(out[0].section).toBe('actions')
    expect(out[1].section).toBe('navigation')
    expect(out.filter((c) => c.section === 'threads')).toHaveLength(5)
    expect(out.at(-1)?.section).toBe('settings')
  })

  it('ranks by title, tolerating a typo', () => {
    expect(rankCommands(commands, 'cowrk')[0].id).toBe('n-cowork')
    expect(rankCommands(commands, 'mcp')[0].id).toBe('s-mcp')
  })

  it('finds a command by its keywords', () => {
    expect(rankCommands(commands, 'conversation')[0].id).toBe('a-new')
  })

  it('searches every thread, not only the five shown by default', () => {
    expect(rankCommands(commands, 'Old thread 7').map((c) => c.id)).toContain(
      't-x7'
    )
  })

  it('is synchronous and local: no fetch is made', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    rankCommands(commands, 'anything')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
