import { describe, it, expect, vi } from 'vitest'

const requestApproval = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  approvalSourceFor: () => 'prompted',
  useToolApprovalRequests: { getState: () => ({ requestApproval }) },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => 'browser click e12 (button "Delete account")'),
  Channel: class {},
}))

import {
  browserAlwaysAsks,
  browserCallClass,
  browserInputForPrompt,
  describeBrowserCall,
  localBrowserSummary,
} from '../browserTool'
import { AGENT_TOOL_NAMES, approveBrowserTool } from '../agentTools'
import { isReviewDeniedBrowserTool } from '../coworkTools'

describe('browserCallClass', () => {
  it('lets looking run, asks for acting, and always asks for open and evaluate', () => {
    for (const a of ['snapshot', 'screenshot', 'console', 'wait', 'scroll', 'close', 'Snapshot']) {
      expect(browserCallClass({ action: a })).toBe('read')
    }
    for (const a of ['click', 'type', 'press', 'select', 'back', 'reload']) {
      expect(browserCallClass({ action: a })).toBe('act')
    }
    expect(browserCallClass({ action: 'open' })).toBe('open')
    expect(browserCallClass({ action: 'evaluate' })).toBe('evaluate')
    expect(browserAlwaysAsks('open')).toBe(true)
    expect(browserAlwaysAsks('evaluate')).toBe(true)
    expect(browserAlwaysAsks('act')).toBe(false)
  })

  it('never classes a missing or unknown action as looking', () => {
    for (const bad of [undefined, null, {}, { action: 3 }, { action: 'snapshots' }, 'snapshot']) {
      expect(browserCallClass(bad)).toBe('act')
    }
  })
})

describe('prompt wording', () => {
  it('summarises a call without the typed text', () => {
    expect(localBrowserSummary({ action: 'type', ref: 'e3', text: 'hunter2' })).toBe(
      'browser type into e3 (7 characters)'
    )
    expect(localBrowserSummary({ action: 'open', url: 'http://localhost:5173/' })).toBe(
      'browser open http://localhost:5173/'
    )
    expect(browserInputForPrompt({ action: 'type', ref: 'e3', text: 'hunter2' })).toEqual({
      action: 'type',
      ref: 'e3',
      text: '[7 characters]',
    })
    expect(browserInputForPrompt({ action: 'click', ref: 'e3' })).toEqual({ action: 'click', ref: 'e3' })
  })

  it('prefers the backend description and falls back to its own', async () => {
    expect(await describeBrowserCall({ action: 'click', ref: 'e12' }, 't1', async () => 'from backend')).toBe('from backend')
    expect(
      await describeBrowserCall({ action: 'click', ref: 'e12' }, 't1', async () => {
        throw new Error('no backend')
      })
    ).toBe('browser click e12')
  })
})

describe('approveBrowserTool', () => {
  const opts = (over: Record<string, unknown> = {}) => ({ callId: 'c1', ...over })

  it('does not ask about looking', async () => {
    requestApproval.mockClear()
    expect(await approveBrowserTool({ action: 'snapshot' }, 't1', opts())).toBeNull()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('asks about acting, with typed text hidden, and obeys the answer', async () => {
    requestApproval.mockReset().mockResolvedValue(true)
    expect(await approveBrowserTool({ action: 'type', ref: 'e1', text: 'secret' }, 't1', opts())).toBeNull()
    const [id, tool, thread, , ctx] = requestApproval.mock.calls[0]
    expect([id, tool, thread]).toEqual(['c1', 'browser', 't1'])
    expect(ctx.alwaysAsk).toBe(false)
    expect(JSON.stringify(ctx.input)).not.toContain('secret')
    requestApproval.mockResolvedValue(false)
    expect(await approveBrowserTool({ action: 'click', ref: 'e1' }, 't1', opts())).toMatch(/declined/)
  })

  it('asks every time for open and evaluate', async () => {
    requestApproval.mockReset().mockResolvedValue(true)
    await approveBrowserTool({ action: 'open', url: 'http://localhost:1/' }, 't1', opts())
    await approveBrowserTool({ action: 'evaluate', expression: '1' }, 't1', opts())
    expect(requestApproval.mock.calls.map((c) => c[4].alwaysAsk)).toEqual([true, true])
  })

  it('uses the surface’s own asker when it has one', async () => {
    requestApproval.mockReset()
    const approve = vi.fn(async () => true)
    expect(await approveBrowserTool({ action: 'click', ref: 'e1' }, 't1', opts({ approve }))).toBeNull()
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ alwaysAsk: false }))
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('in an unattended run refuses open and evaluate and lets acting through', async () => {
    requestApproval.mockReset()
    expect(await approveBrowserTool({ action: 'open', url: 'http://localhost:1/' }, 't1', opts({ unattended: true }))).toMatch(/nobody is available/)
    expect(await approveBrowserTool({ action: 'evaluate', expression: '1' }, 't1', opts({ unattended: true }))).toMatch(/nobody is available/)
    expect(await approveBrowserTool({ action: 'click', ref: 'e1' }, 't1', opts({ unattended: true }))).toBeNull()
    expect(requestApproval).not.toHaveBeenCalled()
  })
})

describe('registration', () => {
  it('is an advertised agent tool and is withheld in review mode', () => {
    expect(AGENT_TOOL_NAMES.has('browser')).toBe(true)
    expect(isReviewDeniedBrowserTool('browser')).toBe(true)
    expect(isReviewDeniedBrowserTool('browser_click')).toBe(true)
    expect(isReviewDeniedBrowserTool('read')).toBe(false)
  })
})
