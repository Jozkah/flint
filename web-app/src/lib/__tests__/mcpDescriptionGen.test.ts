import { describe, it, expect, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import {
  buildDescribePrompt,
  cleanDescription,
  descriptionsToSave,
  selectServersForGeneration,
  summarizeInputSchema,
  type ReviewItem,
} from '../mcpDescriptionGen'
import type { MCPServers } from '@/hooks/useMCPServers'

const server = (description?: string) => ({
  command: 'x',
  args: [],
  env: {},
  ...(description !== undefined ? { description } : {}),
})

describe('selectServersForGeneration', () => {
  const servers: MCPServers = {
    a: server(),
    b: server('Reads files.'),
    c: server('   '),
    d: server(''),
  }

  it('only empty picks servers without a real description', () => {
    expect(selectServersForGeneration(servers, 'empty')).toEqual(['a', 'c', 'd'])
  })

  it('all picks every server', () => {
    expect(selectServersForGeneration(servers, 'all')).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('buildDescribePrompt', () => {
  it('includes the name, tools, descriptions and argument summaries', () => {
    const prompt = buildDescribePrompt('fs', [
      {
        name: 'read_file',
        description: 'Read a file\nfrom disk',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, max: { type: 'number' } },
          required: ['path'],
        },
      },
    ])
    expect(prompt).toContain('Server name: fs')
    expect(prompt).toContain('Tools (1):')
    expect(prompt).toContain('- read_file(path: string, max?: number) - Read a file from disk')
    expect(prompt).toMatch(/1 to 3/)
  })

  it('marks an empty tool list and cuts long lists', () => {
    expect(buildDescribePrompt('x', [])).toContain('- (none)')
    const many = Array.from({ length: 45 }, (_, i) => ({
      name: `t${i}`,
      description: '',
      inputSchema: {},
    }))
    expect(buildDescribePrompt('x', many)).toContain('...and 5 more tools')
  })

  it('summarizes schemas without properties as empty', () => {
    expect(summarizeInputSchema({})).toBe('')
    expect(summarizeInputSchema({ properties: { a: { type: ['string', 'null'] } } })).toBe(
      'a?: string|null'
    )
  })
})

describe('cleanDescription', () => {
  it('strips reasoning, markdown and quotes', () => {
    expect(
      cleanDescription('<think>hmm</think>\n"**Reads** and writes files."')
    ).toBe('Reads and writes files.')
  })

  it('rejects unfinished reasoning and empty output', () => {
    expect(cleanDescription('<think>still going')).toBeNull()
    expect(cleanDescription('  ')).toBeNull()
  })
})

describe('descriptionsToSave', () => {
  const servers: MCPServers = {
    empty: server(),
    mine: server('My own words.'),
    changed: server('Edited meanwhile.'),
  }
  const item = (p: Partial<ReviewItem> & { server: string }): ReviewItem => ({
    before: '',
    text: 'Generated.',
    decision: 'accepted',
    ...p,
  })

  it('saves accepted items only', () => {
    expect(
      descriptionsToSave(
        [
          item({ server: 'empty' }),
          item({ server: 'mine', before: 'My own words.', decision: 'pending' }),
        ],
        servers
      )
    ).toEqual({ empty: 'Generated.' })
  })

  it('never writes a rejected or pending item over a user description', () => {
    expect(
      descriptionsToSave(
        [
          item({ server: 'mine', before: 'My own words.', decision: 'rejected' }),
          item({ server: 'mine', before: 'My own words.', decision: 'pending' }),
        ],
        servers
      )
    ).toEqual({})
  })

  it('overwrites a user description only after an explicit accept', () => {
    expect(
      descriptionsToSave(
        [item({ server: 'mine', before: 'My own words.', text: ' New. ' })],
        servers
      )
    ).toEqual({ mine: 'New.' })
  })

  it('skips servers whose description changed since generation, or that are gone', () => {
    expect(
      descriptionsToSave(
        [item({ server: 'changed', before: '' }), item({ server: 'gone' })],
        servers
      )
    ).toEqual({})
  })

  it('skips an accepted item edited down to nothing', () => {
    expect(descriptionsToSave([item({ server: 'empty', text: '  ' })], servers)).toEqual({})
  })
})
