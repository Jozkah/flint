import { describe, expect, it } from 'vitest'
import { approvalNotice, prNotice, runEndNotice } from '../push'

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
