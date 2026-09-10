/**
 * The review for a proposed change. The backend decides what lands; what this
 * proves is that the renderer asks for exactly what the person chose, by id,
 * and shows the backend's refusal against the hunk it names.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))

import { CoworkProposalReview } from '../CoworkProposalReview'
import {
  approvalFor,
  defaultSelection,
  type ProposalRecord,
} from '@/lib/proposals'

const worktree = {
  path: 'C:/data/worktrees/r/s1',
  branch: 'jan/cowork/s1',
  baseSha: 'abc',
  sourceRoot: 'C:/project',
  identity: { root: 'C:/project', firstCommit: 'f' },
  uncommittedAtCreation: [],
}

const scope = {
  session: 's1',
  run: '',
  call: '',
  invocation: '',
  agent: 'main',
  subject: '',
  project: 'C:/project',
  worktree: worktree.path,
}

const hunk = (id: string, line: number) => ({
  id,
  oldStart: line,
  oldLen: 1,
  newStart: line,
  newLen: 1,
  removed: ['old'],
  added: ['new'],
})

const record = (over: Partial<ProposalRecord> = {}): ProposalRecord => ({
  schemaVersion: 1,
  id: 'prop-1',
  scope,
  baseCommit: 'abc',
  files: [
    {
      path: 'a.txt',
      change: 'modified',
      baseBlob: 'b1',
      proposedBlob: 'p1',
      binary: false,
      oversized: false,
      sensitive: false,
      additions: 2,
      deletions: 2,
      hunks: [hunk('0.0-aaa', 1), hunk('0.1-bbb', 8)],
    },
    {
      path: 'secret.env',
      change: 'added',
      baseBlob: null,
      proposedBlob: 'p2',
      binary: false,
      oversized: false,
      sensitive: true,
      additions: 1,
      deletions: 0,
      hunks: [hunk('1.0-ccc', 1)],
    },
  ],
  patchHash: 'ph',
  baseStateHash: 'bh',
  createdAt: '2026-09-10T00:00:00Z',
  state: 'pending',
  history: [],
  ...over,
})

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd)

beforeEach(() => {
  invoke.mockReset()
})

describe('approvalFor', () => {
  it('sends a fully chosen file as all, a partly chosen one by id, and leaves out the rest', () => {
    const r = record()
    expect(approvalFor(r, { 'a.txt': ['0.0-aaa', '0.1-bbb'] }).files).toEqual([
      { path: 'a.txt', hunks: { kind: 'all' } },
    ])
    expect(approvalFor(r, { 'a.txt': ['0.1-bbb'] }).files).toEqual([
      { path: 'a.txt', hunks: { kind: 'only', ids: ['0.1-bbb'] } },
    ])
    expect(approvalFor(r, { 'a.txt': [] }).files).toEqual([])
  })

  it('binds the approval to the hashes and scope the backend stored', () => {
    const a = approvalFor(record(), defaultSelection(record()))
    expect(a).toMatchObject({
      proposalId: 'prop-1',
      patchHash: 'ph',
      baseStateHash: 'bh',
      scope,
    })
  })

  it('never selects a credential-shaped file by default', () => {
    expect(defaultSelection(record())).not.toHaveProperty('secret.env')
  })
})

describe('the review', () => {
  it('applies only the hunks left checked', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_proposal_list') return [record()]
      if (cmd === 'agent_proposal_apply')
        return {
          proposalId: 'prop-1',
          state: 'partially-applied',
          filesWritten: 1,
        }
      return null
    })
    const onApplied = vi.fn()
    render(
      <CoworkProposalReview
        worktree={worktree}
        session="s1"
        onApplied={onApplied}
      />
    )
    await screen.findAllByTestId('proposal-hunk')
    // Untick the first hunk of a.txt.
    await userEvent.click(screen.getAllByTestId('proposal-hunk-toggle')[0])
    await userEvent.click(screen.getByTestId('proposal-apply'))
    await waitFor(() => expect(calls('agent_proposal_apply')).toHaveLength(1))
    const { approval } = calls('agent_proposal_apply')[0][1]
    expect(approval.files).toEqual([
      { path: 'a.txt', hunks: { kind: 'only', ids: ['0.1-bbb'] } },
    ])
    expect(await screen.findByTestId('proposal-message')).toHaveTextContent(
      'Applied 1 file(s)'
    )
    expect(onApplied).toHaveBeenCalled()
  })

  it('shows a conflict against the hunk it belongs to, and says nothing was applied', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_proposal_list') return [record()]
      if (cmd === 'agent_proposal_apply')
        throw {
          message:
            '1 selected change(s) overlap edits made since the proposal; nothing was written',
          conflicts: [
            {
              path: 'a.txt',
              hunk: '0.0-aaa',
              reason: 'the same lines were changed at the destination',
            },
          ],
        }
      return null
    })
    const onApplied = vi.fn()
    render(
      <CoworkProposalReview
        worktree={worktree}
        session="s1"
        onApplied={onApplied}
      />
    )
    await screen.findAllByTestId('proposal-hunk')
    await userEvent.click(screen.getByTestId('proposal-apply'))
    const conflict = await screen.findByTestId('proposal-conflict')
    expect(conflict.closest('[data-hunk]')?.getAttribute('data-hunk')).toBe(
      '0.0-aaa'
    )
    expect(screen.getByTestId('proposal-error')).toHaveTextContent(
      'nothing was written'
    )
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('offers no way to apply a credential-shaped file', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'agent_proposal_list' ? [record()] : null
    )
    render(<CoworkProposalReview worktree={worktree} session="s1" />)
    const files = await screen.findAllByTestId('proposal-file')
    const secret = files.find(
      (f) => f.getAttribute('data-path') === 'secret.env'
    )!
    const toggle = secret.querySelector(
      '[data-testid="proposal-file-toggle"]'
    ) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(secret.querySelector('[data-testid="proposal-hunk"]')).toBeNull()
  })

  it('creates a proposal from the worktree on request, and shows a refusal', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_proposal_list') return []
      if (cmd === 'agent_proposal_from_worktree')
        throw {
          message: 'the worktree has no changes to propose',
          conflicts: [],
        }
      return null
    })
    render(<CoworkProposalReview worktree={worktree} session="s1" />)
    await userEvent.click(await screen.findByTestId('proposal-create'))
    expect(await screen.findByTestId('proposal-error')).toHaveTextContent(
      'no changes to propose'
    )
    expect(calls('agent_proposal_from_worktree')[0][1]).toMatchObject({
      record: worktree,
      session: 's1',
    })
  })

  it('rejects the whole proposal', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'agent_proposal_list' ? [record()] : null
    )
    render(<CoworkProposalReview worktree={worktree} session="s1" />)
    await userEvent.click(await screen.findByTestId('proposal-reject'))
    await waitFor(() => expect(calls('agent_proposal_reject')).toHaveLength(1))
    expect(calls('agent_proposal_reject')[0][1]).toEqual({
      id: 'prop-1',
      scope,
    })
  })

  it("does not show another worktree's proposal", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'agent_proposal_list'
        ? [
            record({
              scope: { ...scope, worktree: 'C:/data/worktrees/r/other' },
            }),
          ]
        : null
    )
    render(<CoworkProposalReview worktree={worktree} session="s1" />)
    expect(await screen.findByTestId('proposal-create')).toBeInTheDocument()
    expect(screen.queryByTestId('proposal-file')).toBeNull()
  })
})
