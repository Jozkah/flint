import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const words: Record<string, string> = {
  'messaging:stopNotice.stoppedBy': 'Stopped by',
  'messaging:stopNotice.reason': 'reason:',
  'messaging:stopNotice.approvedIn': 'approved in',
}
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => words[k] ?? k }),
}))

import { useToolApproval } from '@/hooks/useToolApproval'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { describePermissionRequest, scopesFor } from '../permissionRequest'
import { allowedToolNames } from '../coworkTools'
import { SESSION_MESSAGING_TOOLS, ALWAYS_ASK_TOOLS } from '../sessionMessagingTools'
import { coworkTurnsToUIMessages } from '../coworkTurns'
import { SessionStopNotice } from '@/containers/SessionStopNotice'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('stop_session is never answered by a standing grant', () => {
  beforeEach(() => {
    useToolApproval.setState({
      approvedTools: { A: ['stop_session'] },
      approvedToolsGlobal: ['stop_session'],
      allowAllMCPPermissions: true,
      approvedMcpTools: {},
      approvedServers: [],
      invalidatedServers: [],
    })
    useToolApprovalRequests.setState({ pending: {}, queued: {}, refusals: {}, approvedFingerprints: {} })
  })

  it('prompts despite allow-all, always-allow and conversation grants', async () => {
    let settled = false
    const answer = useToolApprovalRequests
      .getState()
      .requestApproval('c1', 'stop_session', 'A', undefined, { input: { session_id: 'B', reason: 'r' } })
      .then((v) => {
        settled = true
        return v
      })
    await flush()
    expect(settled).toBe(false)
    expect(useToolApprovalRequests.getState().pending.c1?.toolName).toBe('stop_session')
    // A tool that is not always-ask is still answered by those grants.
    // "Allow all MCP" covers MCP tools only, so the built-in `write` needs a
    // grant of its own -- the same always-allow kind stop_session ignores.
    useToolApproval.setState({ approvedToolsGlobal: ['stop_session', 'write'] })
    await expect(
      useToolApprovalRequests.getState().requestApproval('c2', 'write', 'A')
    ).resolves.toBe(true)

    useToolApprovalRequests.getState().resolveApproval('c1', 'allow-once')
    await expect(answer).resolves.toBe(true)
  })

  it('"always" or "this conversation" on its prompt records no grant', async () => {
    useToolApproval.setState({ approvedTools: {}, approvedToolsGlobal: [], allowAllMCPPermissions: false })
    for (const decision of ['allow-always', 'allow-thread'] as const) {
      const p = useToolApprovalRequests.getState().requestApproval('c', 'stop_session', 'A')
      await flush()
      useToolApprovalRequests.getState().resolveApproval('c', decision)
      await expect(p).resolves.toBe(true)
    }
    const state = useToolApproval.getState()
    expect(state.approvedToolsGlobal).toEqual([])
    expect(state.approvedTools).toEqual({})
    expect(state.isToolApproved('A', 'stop_session')).toBe(false)
  })

  it('the prompt offers only "Allow once", names the session and shows the reason', () => {
    expect(ALWAYS_ASK_TOOLS.has('stop_session')).toBe(true)
    expect(scopesFor({ toolName: 'stop_session' })).toEqual(['allow-once'])
    const d = describePermissionRequest({
      toolName: 'stop_session',
      input: { session: 'Beta', session_id: 'B', reason: 'we both own src/x.ts' },
    })
    expect(d.action).toEqual({ key: 'permissions:action.stopSession', values: { session: 'Beta' } })
    expect(d.reason).toBe('we both own src/x.ts')
    expect(d.resources).toEqual(['Beta'])
    expect(d.scopesOffered).toEqual(['allow-once'])
  })
})

describe('where stop_session is offered', () => {
  it('is withheld in plan (review) mode, and is a session-only messaging tool', () => {
    const base = { subagentNames: [], allowSubagents: true, webSearch: false }
    expect(allowedToolNames(['read', 'stop_session'], { ...base, planMode: true })).toEqual(['read'])
    expect(allowedToolNames(['read', 'stop_session'], { ...base, planMode: false })).toEqual([
      'read',
      'stop_session',
    ])
    // The set chat threads drop and subagents are denied.
    expect(SESSION_MESSAGING_TOOLS.has('stop_session')).toBe(true)
  })
})

describe('the attribution row', () => {
  it('is a display-only row rendered as plain text', () => {
    const reason = '**bold** <img src=x onerror=alert(1)> [link](http://x)'
    const messages = coworkTurnsToUIMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        stopNotice: { requestId: 's1', fromSessionId: 'A', fromName: 'Alpha', reason, at: 1 },
      },
    ])
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const part = messages[1].parts[0] as { type: string; data: { reason: string } }
    expect(part.type).toBe('data-session-stop')
    expect(part.data.reason).toBe(reason)

    const { container } = render(
      <SessionStopNotice
        notice={{ requestId: 's1', fromSessionId: 'A', fromName: 'Alpha', reason, at: 1 }}
      />
    )
    const row = screen.getByTestId('session-stop-notice')
    expect(row.textContent).toBe(`Stopped by Alpha — reason: ${reason} (approved in Alpha)`)
    expect(screen.getByTestId('session-stop-notice-reason').textContent).toBe(reason)
    expect(container.querySelector('img, strong, a')).toBeNull()
  })
})
