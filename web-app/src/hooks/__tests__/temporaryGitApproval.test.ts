import { beforeEach, describe, expect, it } from 'vitest'
import {
  canTemporarilyAllowGit,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import {
  resetAutoApproveStreak,
  useAutoApproveLimit,
} from '@/hooks/useAutoApproveLimit'

describe('temporary Git conversation approval', () => {
  beforeEach(() => {
    useToolApprovalRequests.setState({
      pending: {},
      queued: {},
      refusals: {},
      approvedFingerprints: {},
      answeredByPrompt: {},
      allowedOnceCommands: {},
      temporaryGitThreads: {},
    })
    useAutoApproveLimit.setState({ limit: 50 })
    resetAutoApproveStreak('git-temp-test')
  })

  it('is offered only for non-destructive remote Git in a stable conversation', () => {
    expect(
      canTemporarilyAllowGit('git', { args: ['push', 'origin', 'main'] })
    ).toBe(true)
    expect(
      canTemporarilyAllowGit('git', {
        args: ['push', '--force', 'origin', 'main'],
      })
    ).toBe(false)
    expect(
      canTemporarilyAllowGit(
        'git',
        { args: ['push', 'origin', 'main'] },
        true
      )
    ).toBe(false)
    expect(canTemporarilyAllowGit('bash', { command: 'git push' })).toBe(false)
  })

  it('allows later safe remote Git calls in the conversation without another prompt', async () => {
    const first = useToolApprovalRequests
      .getState()
      .requestApproval('g1', 'git', 'thread-1', undefined, {
        input: { args: ['push', 'origin', 'main'] },
        alwaysAsk: true,
      })

    const request = useToolApprovalRequests.getState().pending.g1
    expect(request).toBeDefined()
    useToolApprovalRequests
      .getState()
      .resolveApproval('g1', 'allow-git-temporary', request.requestId)
    await expect(first).resolves.toBe(true)
    expect(useToolApprovalRequests.getState().temporaryGitThreads['thread-1']).toBe(
      true
    )

    const next = useToolApprovalRequests
      .getState()
      .requestApproval('g2', 'git', 'thread-1', undefined, {
        input: { args: ['push', 'origin', 'feature'] },
        alwaysAsk: true,
      })
    await expect(next).resolves.toBe(true)
    expect(useToolApprovalRequests.getState().pending.g2).toBeUndefined()
  })

  it('still asks for destructive Git after temporary approval', async () => {
    useToolApprovalRequests.setState({
      temporaryGitThreads: { 'thread-1': true },
    })

    const destructive = useToolApprovalRequests
      .getState()
      .requestApproval('g3', 'git', 'thread-1', undefined, {
        input: { args: ['push', '--force', 'origin', 'main'] },
        alwaysAsk: true,
      })

    const request = useToolApprovalRequests.getState().pending.g3
    expect(request).toBeDefined()
    useToolApprovalRequests
      .getState()
      .resolveApproval('g3', 'deny', request.requestId)
    await expect(destructive).resolves.toBe(false)
  })

  it('still pauses at the unattended-run checkpoint', async () => {
    useToolApprovalRequests.setState({
      temporaryGitThreads: { 'thread-1': true },
    })
    useAutoApproveLimit.setState({ limit: 1 })

    const first = useToolApprovalRequests
      .getState()
      .requestApproval('g4', 'git', 'thread-1', undefined, {
        input: { args: ['push', 'origin', 'feature-a'] },
        alwaysAsk: true,
        autoApproveStreak: 'git-temp-test',
      })
    await expect(first).resolves.toBe(true)
    expect(useToolApprovalRequests.getState().pending.g4).toBeUndefined()

    const second = useToolApprovalRequests
      .getState()
      .requestApproval('g5', 'git', 'thread-1', undefined, {
        input: { args: ['push', 'origin', 'feature-b'] },
        alwaysAsk: true,
        autoApproveStreak: 'git-temp-test',
      })
    const request = useToolApprovalRequests.getState().pending.g5
    expect(request).toBeDefined()
    expect(request.taskContext).toContain('1 tool calls ran without asking')

    useToolApprovalRequests
      .getState()
      .resolveApproval('g5', 'allow-once', request.requestId)
    await expect(second).resolves.toBe(true)
  })
})
