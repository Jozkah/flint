import { describe, it, expect } from 'vitest'
import cases from './selfApprovalCases.json'
import { isSelfApprovalTool, selfApprovalToolsOf } from '@/lib/selfApprovalTools'

describe('isSelfApprovalTool (shared with mcp_trust.rs)', () => {
  for (const c of cases as { name: string; flagged: boolean }[]) {
    it(`${c.name} -> ${c.flagged}`, () => {
      expect(isSelfApprovalTool(c.name)).toBe(c.flagged)
    })
  }

  it('lists the self-approval tools of a server', () => {
    expect(
      selfApprovalToolsOf(['run_command', 'approve_command', 'whitelist_add'])
    ).toEqual(['approve_command', 'whitelist_add'])
    expect(selfApprovalToolsOf(undefined)).toEqual([])
  })
})
