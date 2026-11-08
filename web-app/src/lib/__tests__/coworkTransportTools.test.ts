import { describe, expect, it } from 'vitest'
import type { Tool } from 'ai'
import {
  advertisedGroupsOf,
  assistantProfileBlock,
  composeFrozenTools,
  heldBackToolsOf,
  heldGroupsOf,
  memoryInstructionsOf,
} from '@/lib/coworkTransportTools'
import { ENABLE_TOOLS_NAME, type ToolGroupId } from '@/lib/coworkToolGroups'
import type { CoworkRunConfig } from '@/lib/coworkRunConfig'

const tool = (description: string) => ({ description }) as unknown as Tool

describe('coworkTransportTools', () => {
  const held = { browser: tool('b'), clipboard: tool('c') }

  it('lists held groups not yet opened', () => {
    expect(heldGroupsOf(held, new Set())).toEqual(['browser', 'computer'])
    expect(heldGroupsOf(held, new Set<ToolGroupId>(['browser']))).toEqual(['computer'])
  })

  it('reports the groups an advertised set covers', () => {
    expect([...advertisedGroupsOf({ read: tool('r'), browser: tool('b') })]).toEqual(['browser'])
  })

  it('leaves opened groups out of the held-back list', () => {
    const out = heldBackToolsOf(held, new Set<ToolGroupId>(['browser']))
    expect(out.map((t) => [t.name, t.group])).toEqual([['clipboard', 'computer']])
  })

  it('adds opened groups and keeps enable_tools last while something is held', () => {
    const base = { read: tool('r'), [ENABLE_TOOLS_NAME]: tool('old') }
    const next = composeFrozenTools(base, held, new Set<ToolGroupId>(['browser']))
    expect(Object.keys(next)).toEqual(['read', 'browser', ENABLE_TOOLS_NAME])
    const all = composeFrozenTools(base, held, new Set<ToolGroupId>(['browser', 'computer']))
    expect(Object.keys(all)).toEqual(['read', 'browser', 'clipboard'])
  })

  it('collects FLINT.md and non-empty compatibility files', () => {
    const config = {
      projectInstructions: '  be brief  ',
      compatInstructions: [
        { name: 'A.md', content: 'x' },
        { name: 'B.md', content: '  ' },
      ],
    } as unknown as CoworkRunConfig
    expect(memoryInstructionsOf(config)).toEqual([
      { source: 'jan-md', name: 'FLINT.md', text: 'be brief' },
      { source: 'compat', name: 'A.md', text: 'x' },
    ])
  })

  it('builds the assistant profile only for real instructions', () => {
    expect(assistantProfileBlock(undefined)).toBeUndefined()
    expect(assistantProfileBlock('  ')).toBeUndefined()
    expect(assistantProfileBlock(' Be kind ')).toMatch(/\nBe kind$/)
  })
})
