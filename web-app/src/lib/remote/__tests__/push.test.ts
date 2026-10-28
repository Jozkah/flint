import { describe, expect, it, vi } from 'vitest'
import { useContextSizeApproval } from '@/hooks/useModelContextApproval'
import {
  approvalNotice,
  prNotice,
  runEndNotice,
  startPushForwarding,
} from '../push'

describe('context size prompt push', () => {
  const props = { onApprove: () => {}, onDeny: () => {} }

  it('notifies once when a model needs a context decision, and stops on cleanup', () => {
    useContextSizeApproval.setState({ modalProps: null, isModalOpen: false })
    const emit = vi.fn()
    const stop = startPushForwarding(emit)

    useContextSizeApproval.setState({ modalProps: props, isModalOpen: true })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'push.notify',
        title: 'A model needs your decision',
      })
    )

    // Same prompt again: already announced, not sent twice.
    useContextSizeApproval.setState({ modalProps: { ...props } })
    expect(emit).toHaveBeenCalledTimes(1)

    stop()
    useContextSizeApproval.setState({ modalProps: null })
    useContextSizeApproval.setState({ modalProps: props })
    expect(emit).toHaveBeenCalledTimes(1)
    useContextSizeApproval.setState({ modalProps: null, isModalOpen: false })
  })
})

describe('push notices', () => {
  it('approvals carry the request id and a deep link, no arguments', () => {
    const n = approvalNotice({ requestId: 'r1', toolName: 'Run shell', threadId: 's1' }, { kind: 'cowork', title: 'Fix CI' })
    expect(n).toMatchObject({ category: 'approval', requestId: 'r1', url: '/m/#/cowork/s1', tag: 'approval-r1', body: 'Fix CI: Run shell' })
  })

  it('run endings pick their category', () => {
    expect(runEndNotice('cowork', 's', 'T', undefined).category).toBe('runFinished')
    expect(runEndNotice('chat', 'c', 'T', undefined).category).toBe('chatReply')
    expect(runEndNotice('cowork', 's', 'T', { errorText: 'boom' })).toMatchObject({ category: 'runFailed', title: 'Run failed' })
    expect(runEndNotice('cowork', 's', 'T', { stoppedBy: 'user' }).title).toBe('Run stopped')
  })

  it('PRs notify on merge and on checks turning red, once', () => {
    const pr = { number: 7, title: 'Add x', state: 'open', checks: { failed: 0 } }
    expect(prNotice(undefined, { ...pr, state: 'merged' }, null)).toBeNull()
    expect(prNotice(pr, { ...pr, state: 'merged' }, 's')?.title).toBe('PR #7 merged')
    expect(prNotice(pr, { ...pr, checks: { failed: 2 } }, 's')?.title).toBe('Checks failed on PR #7')
    expect(prNotice({ ...pr, checks: { failed: 1 } }, { ...pr, checks: { failed: 2 } }, 's')).toBeNull()
  })
})
