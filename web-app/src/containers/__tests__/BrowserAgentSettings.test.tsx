import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BrowserAgentSettings } from '../BrowserAgentSettings'
import { useAgentToolsConfig } from '@/hooks/useAgentToolsConfig'

let rules: Array<{
  pattern: string
  verdict: 'allow' | 'deny'
  private_ok: boolean
  added_at: number
}>

beforeEach(() => {
  rules = [
    { pattern: 'docs.rs', verdict: 'allow', private_ok: false, added_at: 1 },
    { pattern: '*.shady.test', verdict: 'deny', private_ok: false, added_at: 2 },
    { pattern: 'localhost', verdict: 'allow', private_ok: true, added_at: 3 },
  ]
  invoke.mockReset()
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case 'browser_agent_rules':
        return rules
      case 'browser_agent_rule_remove':
        rules = rules.filter((r) => r.pattern !== args.pattern)
        return true
      case 'browser_agent_rule_set':
        rules = [
          ...rules.filter((r) => r.pattern !== args.pattern),
          {
            pattern: String(args.pattern),
            verdict: args.verdict as 'allow' | 'deny',
            private_ok: Boolean(args.privateOk),
            added_at: 9,
          },
        ]
        return rules[rules.length - 1]
      default:
        return undefined
    }
  })
  useAgentToolsConfig.setState({
    browserAgentEnabled: false,
    browserAgentMaxActions: 40,
  })
})

describe('BrowserAgentSettings', () => {
  it('lists the saved rules with their verdicts', async () => {
    render(<BrowserAgentSettings />)
    const items = await screen.findAllByTestId('browser-rule-pattern')
    expect(items.map((i) => i.textContent)).toEqual([
      'docs.rs',
      '*.shady.test',
      'localhost',
    ])
    const text = screen.getByTestId('browser-agent-rules').textContent ?? ''
    expect(text).toContain('browser-agent:settings.deny')
    expect(text).toContain('browser-agent:settings.privateOk')
  })

  it('removing a rule revokes it and refreshes the list', async () => {
    render(<BrowserAgentSettings />)
    await screen.findAllByTestId('browser-rule-pattern')
    fireEvent.click(screen.getAllByTestId('browser-rule-remove')[0])
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('browser_agent_rule_remove', {
        pattern: 'docs.rs',
      })
    )
    await waitFor(() =>
      expect(
        screen.getAllByTestId('browser-rule-pattern').map((i) => i.textContent)
      ).toEqual(['*.shady.test', 'localhost'])
    )
  })

  it('says so when there are no rules', async () => {
    rules = []
    render(<BrowserAgentSettings />)
    await waitFor(() =>
      expect(screen.getByTestId('browser-agent-rules').textContent).toContain(
        'browser-agent:settings.empty'
      )
    )
    expect(screen.queryAllByTestId('browser-rule-pattern')).toHaveLength(0)
  })

  it('adds a rule, with the local-address box only for allow rules', async () => {
    render(<BrowserAgentSettings />)
    await screen.findAllByTestId('browser-rule-pattern')
    const input = screen.getByTestId('browser-rule-input')
    const add = screen.getByTestId('browser-rule-add') as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '*.example.org' } })
    fireEvent.click(screen.getByTestId('browser-rule-private'))
    fireEvent.click(add)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('browser_agent_rule_set', {
        pattern: '*.example.org',
        verdict: 'allow',
        privateOk: true,
      })
    )
    await waitFor(() =>
      expect(
        screen.getAllByTestId('browser-rule-pattern').map((i) => i.textContent)
      ).toContain('*.example.org')
    )
    // A block rule cannot be a local-address rule.
    fireEvent.change(screen.getByTestId('browser-rule-verdict'), {
      target: { value: 'deny' },
    })
    expect(screen.queryByTestId('browser-rule-private')).toBeNull()
  })

  it('shows the backend error when a rule is refused', async () => {
    const { toast } = await import('sonner')
    render(<BrowserAgentSettings />)
    await screen.findAllByTestId('browser-rule-pattern')
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'browser_agent_rule_set') throw 'a wildcard over a whole top-level domain is too broad'
      return rules
    })
    fireEvent.change(screen.getByTestId('browser-rule-input'), {
      target: { value: '*.com' },
    })
    fireEvent.click(screen.getByTestId('browser-rule-add'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(String((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain(
      'addFailed'
    )
  })

  it('the switch turns the tools on and the action cap is clamped', async () => {
    render(<BrowserAgentSettings />)
    await screen.findAllByTestId('browser-rule-pattern')
    const cap = screen.getByTestId('browser-agent-max-actions') as HTMLInputElement
    expect(cap.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('browser-agent-enabled'))
    expect(useAgentToolsConfig.getState().browserAgentEnabled).toBe(true)
    await waitFor(() =>
      expect((screen.getByTestId('browser-agent-max-actions') as HTMLInputElement).disabled).toBe(false)
    )
    fireEvent.blur(screen.getByTestId('browser-agent-max-actions'), {
      target: { value: '9999' },
    })
    expect(useAgentToolsConfig.getState().browserAgentMaxActions).toBe(200)
    fireEvent.blur(screen.getByTestId('browser-agent-max-actions'), {
      target: { value: '0' },
    })
    expect(useAgentToolsConfig.getState().browserAgentMaxActions).toBe(1)
  })
})
