import { describe, expect, it } from 'vitest'
import {
  MCP_FIND_TOOLS_NAME,
  budgetMcpTools,
  fitMcpTools,
  mcpRankContextFrom,
  mcpToolBudget,
  mcpUnlocked,
  resetMcpDeck,
  runMcpFindTools,
  type McpToolInfo,
} from '../tool-budget'

const info = (name: string, server: string, description = '', tokens = 100): McpToolInfo => ({
  name,
  server,
  description,
  tokens,
})

/** A large reverse-engineering server plus a few small ones, like a real setup. */
function bigSet(): Record<string, { description: string; inputSchema: unknown }> {
  const tools: Record<string, { description: string; inputSchema: unknown }> = {}
  for (let i = 0; i < 140; i++) {
    tools[`rea_tool_${i}`] = {
      description: `Reverse engineering helper number ${i} for binaries. `.repeat(20),
      inputSchema: { type: 'object', properties: { address: { type: 'string' } } },
    }
  }
  tools.decompile_function = {
    description: 'Decompile a function at an address into pseudo code.',
    inputSchema: { type: 'object' },
  }
  tools.read_file = { description: 'Read a file from disk.', inputSchema: { type: 'object' } }
  tools.github_list_issues = {
    description: 'List the issues of a GitHub repository.',
    inputSchema: { type: 'object' },
  }
  return tools
}

const serverOf = (name: string) =>
  name === 'read_file'
    ? undefined // a built-in
    : name.startsWith('github')
      ? 'github'
      : name === 'decompile_function'
        ? 'ida'
        : name.startsWith('rea_')
          ? 'rea'
          : undefined

const userMsg = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] })

describe('mcpToolBudget', () => {
  it('takes a quarter of a known window and a fixed budget otherwise', () => {
    expect(mcpToolBudget(200_000)).toBe(50_000)
    expect(mcpToolBudget(0)).toBe(24_000)
    expect(mcpToolBudget(4_000)).toBe(2_000)
  })
})

describe('fitMcpTools', () => {
  it('offers everything when it fits', () => {
    const tools = [info('a', 's1'), info('b', 's2')]
    expect(fitMcpTools(tools, 1_000, { queries: ['anything'] })).toEqual({
      offered: ['a', 'b'],
      held: [],
    })
  })

  it('offers the relevant tools and holds the rest when over budget', () => {
    const tools = [
      info('decompile_function', 'ida', 'Decompile a function', 200),
      info('list_issues', 'github', 'List repository issues', 200),
      info('take_screenshot', 'playwright', 'Screenshot the page', 200),
    ]
    const r = fitMcpTools(tools, 450, { queries: ['decompile the main function'] })
    expect(r.offered).toEqual(['decompile_function'])
    expect(r.held.sort()).toEqual(['list_issues', 'take_screenshot'])
  })

  it('holds everything on a message that points at no tool', () => {
    const tools = [info('a_tool', 's1'), info('b_tool', 's2'), info('c_tool', 's3')]
    const r = fitMcpTools(tools, 250, { queries: ['hi'] })
    expect(r.offered).toEqual([])
    expect(r.held).toHaveLength(3)
  })

  it('keeps servers the conversation used recently', () => {
    const tools = [info('x_one', 'ida', '', 200), info('y_two', 'github', '', 200), info('z_three', 'rea', '', 200)]
    const r = fitMcpTools(tools, 450, { queries: ['continue'], recentServers: ['ida'] })
    expect(r.offered).toEqual(['x_one'])
  })

  it('keeps a server the user names', () => {
    const tools = [
      info('x_one', 'ida-multi-mcp', '', 200),
      info('y_two', 'github', '', 200),
      info('z_three', 'rea', '', 200),
    ]
    const r = fitMcpTools(tools, 450, { queries: ['use ida-multi-mcp for this'] })
    expect(r.offered).toEqual(['x_one'])
  })

  it('never exceeds the budget', () => {
    const tools = Array.from({ length: 50 }, (_, i) => info(`decompile_${i}`, 'ida', 'decompile', 100))
    const r = fitMcpTools(tools, 1_000, { queries: ['decompile'] })
    expect(r.offered.length * 100).toBeLessThanOrEqual(1_000)
    expect(r.offered.length + r.held.length).toBe(50)
  })
})

describe('budgetMcpTools + mcp_find_tools', () => {
  it('cuts a 300-tool request to the budget and offers held tools on request', () => {
    const key = 'test-thread'
    resetMcpDeck(key)
    const tools = bigSet()
    const sent = budgetMcpTools(tools, serverOf, key, 20_000, [userMsg('decompile the function at 0x1000')])
    // The built-in is never touched; the relevant tool is offered.
    expect(sent.read_file).toBeDefined()
    expect(sent.decompile_function).toBeDefined()
    expect(sent[MCP_FIND_TOOLS_NAME]).toBeDefined()
    expect(sent.github_list_issues).toBeUndefined()
    expect(Object.keys(sent).length).toBeLessThan(Object.keys(tools).length)

    const found = runMcpFindTools(key, { query: 'github issues' })
    expect(found.isError).toBeFalsy()
    expect(found.output).toContain('github_list_issues')
    expect(mcpUnlocked(key).has('github_list_issues')).toBe(true)

    // The next request offers it.
    const next = budgetMcpTools(tools, serverOf, key, 20_000, [userMsg('decompile the function at 0x1000')])
    expect(next.github_list_issues).toBeDefined()
    resetMcpDeck(key)
  })

  it('sends no meta-tool when everything fits', () => {
    const key = 'fits'
    const sent = budgetMcpTools(
      { github_list_issues: { description: 'x', inputSchema: {} } },
      serverOf,
      key,
      200_000,
      []
    )
    expect(sent[MCP_FIND_TOOLS_NAME]).toBeUndefined()
    expect(runMcpFindTools(key, { query: 'x' }).output).toMatch(/No MCP tools are held/)
    resetMcpDeck(key)
  })

  it('says which servers exist when nothing matches', () => {
    const key = 'nomatch'
    budgetMcpTools(bigSet(), serverOf, key, 4_000, [userMsg('hello')])
    const r = runMcpFindTools(key, { query: 'zzzqqq' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('github')
    resetMcpDeck(key)
  })
})

describe('mcpRankContextFrom', () => {
  it('reads UI and model messages, newest user text last', () => {
    const ctx = mcpRankContextFrom(
      [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: [{ type: 'tool-call', toolName: 'decompile_function' }] },
        userMsg('second question'),
      ],
      serverOf
    )
    expect(ctx.queries).toEqual(['first question', 'second question'])
    expect(ctx.recentServers).toEqual(['ida'])
  })
})
