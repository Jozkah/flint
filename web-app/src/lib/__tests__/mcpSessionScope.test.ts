import { describe, it, expect, beforeEach } from 'vitest'
import { useMcpPlaceholders } from '@/hooks/useMcpPlaceholders'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { chatWithholdsUnresolved, gateUnresolvedTools } from '../mcpSessionScope'
import { coworkWithholdsUnresolved } from '../coworkMcpVars'

const tools = [
  { name: 'open_file', server: 'idea' },
  { name: 'read', server: 'fs' },
]

describe('mcpSessionScope', () => {
  beforeEach(() => {
    useMcpPlaceholders.setState({ placeholders: { idea: ['project_path'] } })
  })

  it('keeps unresolved templates when the mode will ask', () => {
    const out = gateUnresolvedTools(tools, {}, false)
    expect(out.tools).toEqual(tools)
    expect(out.note).toBeNull()
  })

  it('withholds unresolved templates in Auto, with a note for the model', () => {
    const out = gateUnresolvedTools(tools, {}, true)
    expect(out.tools.map((t) => t.server)).toEqual(['fs'])
    expect(out.note).toContain('idea ({{project_path}})')
  })

  it('offers a template once its variables are set', () => {
    const out = gateUnresolvedTools(tools, { project_path: '/p' }, true)
    expect(out.tools).toEqual(tools)
    expect(out.note).toBeNull()
  })

  it('reads Auto from the chat permission mode', () => {
    useToolApproval.setState({ permissionMode: 'ask' })
    expect(chatWithholdsUnresolved()).toBe(false)
    useToolApproval.setState({ permissionMode: 'auto-approve' })
    expect(chatWithholdsUnresolved()).toBe(true)
    useToolApproval.setState({ permissionMode: 'bypass' })
    expect(chatWithholdsUnresolved()).toBe(true)
    useToolApproval.setState({ permissionMode: 'ask' })
  })

  it('reads Auto from the cowork session mode', () => {
    const base = useCoworkSessions.getState().sessions
    useCoworkSessions.setState({
      sessions: [
        { id: 's-ask', mode: 'ask' },
        { id: 's-auto', mode: 'auto' },
      ] as never,
    })
    expect(coworkWithholdsUnresolved('s-ask')).toBe(false)
    expect(coworkWithholdsUnresolved('s-auto')).toBe(true)
    expect(coworkWithholdsUnresolved('missing')).toBe(true)
    useCoworkSessions.setState({ sessions: base })
  })
})
