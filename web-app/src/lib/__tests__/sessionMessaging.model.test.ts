import { describe, it, expect } from 'vitest'
import { coworkTurnsToUIMessages } from '../coworkTurns'
import { subagentTools, parentToolNames } from '../coworkSubagent'
import { allowedToolNames, PLAN_DENIED_TOOLS } from '../coworkTools'
import { SESSION_MESSAGING_TOOL_NAMES } from '../sessionMessagingTools'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useMessageQueue } from '@/stores/message-queue-store'
import type { Tool } from 'ai'

describe('transcript attribution', () => {
  it('maps a mailbox turn to metadata.agentMessage, keeping steered', () => {
    const [plain, mail] = coworkTurnsToUIMessages([
      { role: 'user', content: 'hello' },
      {
        role: 'user',
        content: '[Coordination message ...]\nhi',
        steered: true,
        from: { sessionId: 'S1', displayName: 'Other', messageId: 'm1' },
      },
    ])
    expect(plain.metadata).toBeUndefined()
    expect(mail.metadata).toEqual({
      steered: true,
      agentMessage: { sessionId: 'S1', displayName: 'Other', messageId: 'm1', replyTo: null },
    })
  })
})

describe('messaging tools', () => {
  const tools = (...names: string[]) =>
    Object.fromEntries(names.map((n) => [n, {} as Tool]))

  it('are withheld from subagents', () => {
    const parent = tools('read', ...SESSION_MESSAGING_TOOL_NAMES)
    expect(Object.keys(subagentTools(parent, null))).toEqual(['read'])
    expect(parentToolNames(parent)).toEqual(['read'])
  })

  it('stay available in plan mode: they are read-only', () => {
    for (const name of SESSION_MESSAGING_TOOL_NAMES) {
      expect(PLAN_DENIED_TOOLS.has(name)).toBe(false)
    }
    expect(
      allowedToolNames([...SESSION_MESSAGING_TOOL_NAMES], {
        planMode: true,
        allowSubagents: false,
      } as never)
    ).toEqual([...SESSION_MESSAGING_TOOL_NAMES])
  })
})

describe('queued mail persistence', () => {
  const base = { id: 'A', title: 'A', folder: null, turns: [], messages: [], updated: 0 } as CoworkSession

  it('carries `from` into pendingInput and back through restoreHeld', () => {
    useCoworkSessions.setState({ sessions: [base], currentId: 'A' })
    const from = { sessionId: 'S1', displayName: 'Other', messageId: 'm1', replyTo: null, depth: 2 }
    useCoworkSessions.getState().setPendingInput('A', [
      { id: 'mail:m1', text: 'wrapped', createdAt: 5, held: true, from, extra: 'dropped' } as never,
      { id: 'typed', text: 'mine', createdAt: 6 },
    ])
    const saved = useCoworkSessions.getState().sessions[0].pendingInput
    expect(saved).toEqual([
      { id: 'mail:m1', text: 'wrapped', createdAt: 5, from },
      { id: 'typed', text: 'mine', createdAt: 6 },
    ])
    useMessageQueue.setState({ queues: {} })
    useMessageQueue.getState().restoreHeld('A', saved!)
    expect(useMessageQueue.getState().getQueue('A')[0]).toMatchObject({ held: true, from })
  })

  it('loads sessions saved before `from` existed without a migration step', async () => {
    const persist = useCoworkSessions.persist.getOptions()
    const legacy = {
      sessions: [{ ...base, codePanel: { tabs: [], activeTabId: null, expandedDirs: [], wordWrap: false }, pendingInput: [{ id: '1', text: 'x', createdAt: 1 }] }],
    }
    const migrated = (await persist.migrate!(legacy, persist.version!)) as typeof legacy
    expect(migrated.sessions[0].pendingInput).toEqual([{ id: '1', text: 'x', createdAt: 1 }])
  })
})
