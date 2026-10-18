import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  REFUSAL_REASON_MAX_CHARS,
  cleanRefusalReason,
  useToolApprovalRequests,
} from '../useToolApprovalRequests'
import { useToolApproval } from '../useToolApproval'
import { approvalDeniedText, classifyPermissionOutcome } from '@/lib/permissionOutcome'

vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { toolApproval: 'tool-approval-settings' },
}))
vi.mock('zustand/middleware', () => ({
  persist: (fn: any) => fn,
  createJSONStorage: () => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }),
}))

const store = () => useToolApprovalRequests.getState()

describe('a deny can carry the reason the person typed', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({ pending: {}, queued: {}, refusals: {}, refusalReasons: {}, editedInputs: {} })
    useToolApproval.setState({
      approvedTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      allowAllMCPPermissions: false,
    })
  })

  it('keeps the reason for the call and hands it over once', async () => {
    const answer = store().requestApproval('c1', 'bash', 't1')
    store().resolveApproval('c1', 'deny', store().pending['c1'].requestId, 'use the staging bucket')
    await expect(answer).resolves.toBe(false)
    expect(store().takeRefusal('c1')).toBe('denied')
    expect(store().takeRefusalReason('c1')).toBe('use the staging bucket')
    expect(store().takeRefusalReason('c1')).toBeUndefined()
  })

  it('ignores a reason that comes with an allow', async () => {
    const answer = store().requestApproval('c2', 'write', 't1')
    store().resolveApproval('c2', 'allow-once', store().pending['c2'].requestId, 'ignored')
    await expect(answer).resolves.toBe(true)
    expect(store().takeRefusalReason('c2')).toBeUndefined()
  })

  it('drops blank reasons, replaces control characters and caps the length', () => {
    expect(cleanRefusalReason('  \n\t ')).toBeUndefined()
    expect(cleanRefusalReason(undefined)).toBeUndefined()
    expect(cleanRefusalReason('a\nb')).toBe('a b')
    expect(Array.from(cleanRefusalReason('x'.repeat(900))!)).toHaveLength(REFUSAL_REASON_MAX_CHARS)
  })

  it('adds the reason to the denied text without changing how it is classified', () => {
    expect(approvalDeniedText()).toBe('Tool execution denied by user')
    const withReason = approvalDeniedText('use the staging bucket')
    expect(withReason).toBe('Tool execution denied by user. Their reason: use the staging bucket')
    expect(classifyPermissionOutcome(withReason)?.kind).toBe('denied-by-user')
  })
})

describe('a shell command can be rewritten before it is allowed once', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({ pending: {}, queued: {}, refusals: {}, editedInputs: {} })
    useToolApproval.setState({
      approvedTools: {},
      approvedServers: [],
      approvedToolsGlobal: [],
      allowAllMCPPermissions: false,
    })
  })

  it('hands the edited command over once when the call is allowed once', async () => {
    const answer = store().requestApproval('b1', 'bash', 't1', undefined, { input: { command: 'rm -rf build' } })
    const requestId = store().pending['b1'].requestId
    store().setEditedCommand('b1', requestId, '  rm -rf build/cache  ')
    store().resolveApproval('b1', 'allow-once', requestId)
    await expect(answer).resolves.toBe(true)
    expect(store().takeEditedInput('b1')).toEqual({ command: 'rm -rf build/cache' })
    expect(store().takeEditedInput('b1')).toBeUndefined()
  })

  it('drops the edit when the answer is anything but allow once', async () => {
    const answer = store().requestApproval('b2', 'bash', 't1', undefined, { input: { command: 'ls' } })
    const requestId = store().pending['b2'].requestId
    store().setEditedCommand('b2', requestId, 'ls -la')
    store().resolveApproval('b2', 'deny', requestId)
    await expect(answer).resolves.toBe(false)
    expect(store().takeEditedInput('b2')).toBeUndefined()
  })

  it('ignores edits for other tools, stale requests and blank commands', async () => {
    void store().requestApproval('w1', 'write', 't1', undefined, { input: { path: 'a.txt' } })
    store().setEditedCommand('w1', store().pending['w1'].requestId, 'rm a.txt')
    void store().requestApproval('b3', 'bash', 't1', undefined, { input: { command: 'ls' } })
    store().setEditedCommand('b3', 'req-stale', 'rm -rf /')
    store().setEditedCommand('b3', store().pending['b3'].requestId, '   ')
    expect(store().editedInputs).toEqual({})
  })

  it('drops an edit when the prompt is withdrawn or the conversation stops', async () => {
    void store().requestApproval('b5', 'bash', 't5', undefined, { input: { command: 'ls' } })
    const id5 = store().pending['b5'].requestId
    store().setEditedCommand('b5', id5, 'ls -la')
    store().withdrawApproval(id5)
    expect(store().editedInputs).toEqual({})

    void store().requestApproval('b6', 'bash', 't6', undefined, { input: { command: 'ls' } })
    store().setEditedCommand('b6', store().pending['b6'].requestId, 'ls -la')
    store().clearPendingForThread('t6')
    expect(store().editedInputs).toEqual({})
  })

  it('does not remember an edited command as allowed once before', async () => {
    const answer = store().requestApproval('b4', 'bash', 't9', undefined, { input: { command: 'make test' } })
    const requestId = store().pending['b4'].requestId
    store().setEditedCommand('b4', requestId, 'make test-all')
    store().resolveApproval('b4', 'allow-once', requestId)
    await answer
    expect(store().allowedOnceCommands['t9']).toBeUndefined()
  })
})

describe('which prompts can have their command rewritten', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({ pending: {}, queued: {}, refusals: {}, editedInputs: {} })
  })

  it('allows a plain bash prompt', async () => {
    const { commandEditable } = await import('@/lib/commandEditable')
    expect(commandEditable({ toolName: 'bash' })).toBe(true)
    expect(commandEditable({ toolName: 'write' })).toBe(false)
  })

  it('refuses the offer to rerun a failed command outside the sandbox', async () => {
    const { commandEditable } = await import('@/lib/commandEditable')
    const { NULL_DEVICE_RETRY_REASON } = await import('@/lib/nullDeviceRetry')
    expect(commandEditable({ toolName: 'bash', taskContext: NULL_DEVICE_RETRY_REASON })).toBe(false)
    expect(commandEditable({ toolName: 'bash', conversationProgram: 'git' })).toBe(false)
  })

  it('ignores an edit sent for such a prompt', async () => {
    const { NULL_DEVICE_RETRY_REASON } = await import('@/lib/nullDeviceRetry')
    void store().requestApproval('r1', 'bash', 't1', undefined, {
      input: { command: 'git status' },
      taskContext: NULL_DEVICE_RETRY_REASON,
    })
    store().setEditedCommand('r1', store().pending['r1'].requestId, 'rm -rf /')
    expect(store().editedInputs).toEqual({})
  })
})
