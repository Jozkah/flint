import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { refreshPrStatusAfterGit } from '@/lib/coworkDispatch'
import { planGitCall, type GitPlan } from '@/lib/gitTool'
import { usePrStatusStore } from '@/stores/pr-status-store'

const plan = (program: string, args: string[]): GitPlan => {
  const r = planGitCall(program, args)
  if (!r.ok) throw new Error(r.error)
  return r.plan
}

const found = {
  kind: 'found',
  pr: {
    number: 31,
    title: 'Fix',
    url: 'https://github.com/o/r/pull/31',
    state: 'open',
    head: 'fix/x',
    base: 'master',
    additions: 1,
    deletions: 1,
    checks: { passed: 0, failed: 0, pending: 0 },
  },
}

describe('refreshPrStatusAfterGit', () => {
  beforeEach(() => {
    invoke.mockReset()
    usePrStatusStore.setState({ byFolder: {} })
  })

  // Session 8411d403: `gh pr create` succeeded, and the bar stayed empty
  // because the "no pull request" answer from before was still fresh.
  it('asks again for the session folder after a pull request is opened', async () => {
    const folder = 'C:\\repo'
    usePrStatusStore.setState({
      byFolder: { [folder]: { lookup: { kind: 'no_pull_request' }, at: Date.now(), loading: false } },
    })
    invoke.mockResolvedValue(found)
    const asked = refreshPrStatusAfterGit(
      plan('gh', ['pr', 'create', '--repo', 'o/r', '--head', 'fix/x', '--base', 'master', '--title', 'T', '--body', 'B']),
      { readOnlyFolder: folder, worktreePath: null }
    )
    expect(asked).toEqual([folder])
    await vi.waitFor(() =>
      expect(usePrStatusStore.getState().byFolder[folder]?.lookup).toEqual(found)
    )
    expect(invoke).toHaveBeenCalledWith('agent_pr_status', { project: folder })
  })

  it('also after a push, and not after reads or local changes', () => {
    invoke.mockResolvedValue({ kind: 'no_pull_request' })
    const ctx = { readOnlyFolder: 'C:\\repo', worktreePath: 'C:\\wt' }
    expect(refreshPrStatusAfterGit(plan('git', ['push', '-u', 'origin', 'fix/x']), ctx)).toEqual([
      'C:\\repo',
      'C:\\wt',
    ])
    expect(refreshPrStatusAfterGit(plan('git', ['commit', '-m', 'x']), ctx)).toEqual([])
    expect(refreshPrStatusAfterGit(plan('gh', ['pr', 'view', '1']), ctx)).toEqual([])
    expect(refreshPrStatusAfterGit(plan('gh', ['issue', 'create', '--title', 'T', '--body', 'B']), ctx)).toEqual([])
  })

  it('a forced refresh during a lookup runs once more after it', async () => {
    const folder = 'C:\\repo'
    let first!: (v: unknown) => void
    invoke.mockImplementationOnce(() => new Promise((r) => (first = r)))
    invoke.mockResolvedValueOnce(found)
    const running = usePrStatusStore.getState().refresh(folder, true)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    void usePrStatusStore.getState().refresh(folder, true)
    first({ kind: 'no_pull_request' })
    await running
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(usePrStatusStore.getState().byFolder[folder]?.lookup).toEqual(found)
  })
})
