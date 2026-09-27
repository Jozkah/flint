import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
const openUrl = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ opener: () => ({ openUrl }) }),
}))
const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

import { PrBar } from '../PrBar'
import { usePrStatusStore, claimKey, type PrStatus } from '@/stores/pr-status-store'
import { useMessageQueue } from '@/stores/message-queue-store'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const FOLDER = '/repo'
const pr: PrStatus = {
  number: 7,
  title: 'Fix',
  url: 'https://github.com/o/r/pull/7',
  state: 'open',
  head: 'flint/fix',
  base: 'main',
  additions: 3,
  deletions: 1,
  checks: { passed: 1, failed: 1, pending: 0 },
  head_sha: SHA,
  check_runs: [
    { name: 'lint', workflow: 'CI', verdict: 'passed', conclusion: 'SUCCESS', details_url: null, job_id: null },
    {
      name: 'unit tests',
      workflow: 'CI',
      verdict: 'failed',
      conclusion: 'FAILURE',
      details_url: 'https://github.com/o/r/actions/runs/1/job/22',
      job_id: 22,
    },
  ],
}

function seed(claimedBy: string) {
  usePrStatusStore.setState({
    byFolder: { [FOLDER]: { lookup: { kind: 'found', pr }, at: Date.now(), loading: false } },
    byUrl: {},
    sessionPrs: {},
    claims: { [claimKey(FOLDER, 7)]: claimedBy },
  })
}

const openMenu = () => {
  const trigger = screen.getByRole('button', { name: /CI/ })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.keyDown(trigger, { key: 'Enter' })
}

describe('PrBar named checks', () => {
  beforeEach(() => {
    invoke.mockReset()
    useMessageQueue.setState({ queues: {} })
  })

  it('lists named checks, failed first, and offers the fix to the owning session', async () => {
    seed('s1')
    render(<PrBar folder={FOLDER} sessionId="s1" />)
    openMenu()
    const rows = await screen.findAllByTestId('pr-check')
    expect(rows.map((r) => r.getAttribute('data-verdict'))).toEqual(['failed', 'passed'])
    expect(screen.getByTestId('pr-check-fix')).toBeTruthy()
    expect(screen.getByTestId('pr-check-details')).toBeTruthy()
  })

  it('queues the fix into this session only after the backend confirms the head', async () => {
    seed('s1')
    invoke.mockResolvedValue({ kind: 'log', excerpt: 'FAIL a.test.ts', truncated: false, head_sha: SHA })
    render(<PrBar folder={FOLDER} sessionId="s1" />)
    openMenu()
    fireEvent.click(await screen.findByTestId('pr-check-fix'))
    await waitFor(() => expect(useMessageQueue.getState().getQueue('s1')).toHaveLength(1))
    expect(invoke).toHaveBeenCalledWith('agent_pr_check_log', {
      project: FOLDER,
      prUrl: pr.url,
      headSha: SHA,
      jobId: 22,
      detailsUrl: 'https://github.com/o/r/actions/runs/1/job/22',
    })
    expect(useMessageQueue.getState().getQueue('s1')[0].text).toContain('FAIL a.test.ts')
  })

  it('queues nothing when the head moved since the check ran', async () => {
    seed('s1')
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'agent_pr_check_log'
        ? { kind: 'stale', current_head_sha: 'f'.repeat(40) }
        : { kind: 'found', pr }
    )
    render(<PrBar folder={FOLDER} sessionId="s1" />)
    openMenu()
    fireEvent.click(await screen.findByTestId('pr-check-fix'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agent_pr_status', { project: FOLDER })
    )
    expect(useMessageQueue.getState().getQueue('s1')).toHaveLength(0)
  })

  it('shows nothing for a session that does not own the pull request', () => {
    seed('s2')
    render(<PrBar folder={FOLDER} sessionId="s1" />)
    expect(screen.queryByTestId('pr-bar')).toBeNull()
  })
})
