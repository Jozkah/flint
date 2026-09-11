/**
 * The shipped roles (AH-094..099) as the renderer resolves them. The backend
 * lists the definitions; these check that a role's authority is its
 * allowlist narrowed by the parent -- never more -- and that nothing a child
 * asks for at the call site can widen it.
 */
import { describe, it, expect } from 'vitest'
import { resolveSubagent, subagentTools } from '../coworkSubagent'
import type { SubagentDefinition } from '../coworkSubagentRegistry'

const role = (name: string, tools: string[]): SubagentDefinition => ({
  name,
  description: `${name} (built-in role, v1)`,
  system_prompt: `You are the ${name}.`,
  allowed_tools: tools,
  model: null,
  scope: 'builtin',
})

const READ = ['read', 'ls', 'find', 'grep']
const ROLES = [
  role('explorer', READ),
  role('planner', READ),
  role('implementer', [...READ, 'write', 'edit']),
  role('reviewer', READ),
  role('tester', [...READ, 'bash']),
  role('security', READ),
]

const PARENT = ['read', 'ls', 'find', 'grep', 'write', 'edit', 'bash', 'web_fetch', 'mcp__github__create_issue', 'skill_read']

const tools = (name: string, parent = PARENT, allowed?: string[]) => {
  const r = resolveSubagent({ subagent_name: name, description: 'do it', ...(allowed ? { allowed_tools: allowed } : {}) }, ROLES, parent)
  if ('error' in r) throw new Error(r.error)
  return r.allowedTools ?? []
}

describe('built-in roles', () => {
  it('read-only roles get no tool that writes, runs, reaches the network or an MCP server', () => {
    for (const name of ['explorer', 'planner', 'reviewer', 'security']) {
      const got = tools(name)
      for (const forbidden of ['write', 'edit', 'bash', 'web_fetch', 'mcp__github__create_issue']) {
        expect(got, `${name} got ${forbidden}`).not.toContain(forbidden)
      }
      expect(got).toContain('read')
    }
  })

  it('a call site cannot widen a role, and asking for more is refused', () => {
    const r = resolveSubagent({ subagent_name: 'reviewer', description: 'x', allowed_tools: ['write'] }, ROLES, PARENT)
    expect(r).toMatchObject({ error: expect.stringMatching(/outside the subagent definition/) })
    // Narrowing is allowed.
    expect(tools('implementer', PARENT, ['read'])).toEqual(['read', 'skill_read'])
  })

  it('a role never holds what its parent lacks', () => {
    const readOnlyParent = ['read', 'ls', 'grep']
    const got = tools('implementer', readOnlyParent)
    expect(got).not.toContain('write')
    expect(got).not.toContain('edit')
    expect(tools('tester', readOnlyParent)).not.toContain('bash')
  })

  it('no role is ever offered the dispatch or conversation tools', () => {
    const parentTools = Object.fromEntries(
      [...PARENT, 'task', 'team', 'ask', 'todo'].map((n) => [n, {} as never])
    )
    for (const r of ROLES) {
      const offered = Object.keys(subagentTools(parentTools, tools(r.name)))
      for (const withheld of ['task', 'team', 'ask', 'todo']) {
        expect(offered, `${r.name} offered ${withheld}`).not.toContain(withheld)
      }
    }
  })

  it('a saved definition of the same name wins over the built-in when listed first', () => {
    const saved: SubagentDefinition = { ...role('reviewer', ['read', 'write']), scope: 'user', description: 'mine' }
    const r = resolveSubagent({ subagent_name: 'reviewer', description: 'x' }, [saved, ...ROLES.filter((d) => d.name !== 'reviewer')], PARENT)
    expect('error' in r ? r.error : r.allowedTools).toContain('write')
  })
})
