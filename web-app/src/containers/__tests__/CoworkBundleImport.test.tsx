/**
 * The import surface (AH-169). The backend decides what an import is and
 * whether it applies; these check that the renderer names the bundle and the
 * destination, shows a typed refusal, can stop an import, lists pending
 * imports read from disk, and applies through an approval bound to the
 * import rather than the plain proposal apply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))

import { CoworkBundleImport } from '../CoworkBundleImport'
import type { ImportView } from '@/lib/bundleImport'
import type { ProposalRecord } from '@/lib/proposals'

const proposal: ProposalRecord = {
  schemaVersion: 1,
  id: 'prop-1',
  scope: {
    session: 'import:imp-1',
    run: '',
    call: '',
    invocation: '',
    agent: 'bundle',
    subject: 'bundle abc from jan/cowork/x at 0123456789',
    project: 'C:/dest',
    worktree: 'bundle:imp-1',
  },
  baseCommit: '0123456789abcdef0123456789abcdef01234567',
  files: [
    {
      path: 'a.txt',
      change: 'modified',
      baseBlob: 'b',
      proposedBlob: 'p',
      binary: false,
      oversized: false,
      sensitive: false,
      additions: 1,
      deletions: 1,
      hunks: [
        { id: 'h1', oldStart: 1, oldLen: 1, newStart: 1, newLen: 1, removed: ['a'], added: ['A'] },
      ],
    },
  ],
  patchHash: 'ph',
  baseStateHash: 'bh',
  createdAt: 't',
  state: 'pending',
  history: [],
}

const view = (over: Partial<ImportView> = {}): ImportView => ({
  schemaVersion: 1,
  id: 'imp-1',
  bundleSchema: 1,
  bundleSha256: 'f'.repeat(64),
  manifestSha256: 'e'.repeat(64),
  patchSha256: 'd'.repeat(64),
  originRepository: 'C:/elsewhere/repo',
  branch: 'jan/cowork/x',
  baseSha: proposal.baseCommit,
  headSha: '',
  exportedAt: 't',
  destination: 'C:/dest',
  destinationFirstCommit: null,
  proposalId: 'prop-1',
  state: 'pending',
  createdAt: 't',
  endedAt: null,
  files: [{ path: 'a.txt', change: 'modified', whole: false }],
  proposal,
  ...over,
})

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd)

beforeEach(() => invoke.mockReset())

describe('CoworkBundleImport', () => {
  it('imports the picked bundle into this project and shows a typed refusal', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_bundle_imports_list') return []
      if (cmd === 'agent_bundle_import')
        throw { kind: 'hash-mismatch', message: 'changes.patch does not match its hash' }
      return null
    })
    render(
      <CoworkBundleImport destination="C:/dest" session="s1" pickFolder={async () => 'C:/bundles/b1'} />
    )
    await userEvent.click(await screen.findByTestId('bundle-import'))
    const error = await screen.findByTestId('bundle-import-error')
    expect(error).toHaveAttribute('data-kind', 'hash-mismatch')
    expect(error).toHaveTextContent('does not match its hash')
    const [, args] = calls('agent_bundle_import')[0]
    expect(args).toMatchObject({ bundle: 'C:/bundles/b1', destination: 'C:/dest' })
    expect(args.token).toMatch(/^t-/)
  })

  it('does nothing when the picker is closed', async () => {
    invoke.mockResolvedValue([])
    render(<CoworkBundleImport destination="C:/dest" session="s1" pickFolder={async () => null} />)
    await userEvent.click(await screen.findByTestId('bundle-import'))
    expect(calls('agent_bundle_import')).toHaveLength(0)
  })

  it('can stop an import that is still running', async () => {
    let finish: (v: unknown) => void = () => {}
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_bundle_imports_list') return []
      if (cmd === 'agent_bundle_import') return new Promise((_, reject) => (finish = reject))
      if (cmd === 'agent_bundle_import_cancel') {
        finish({ kind: 'cancelled', message: 'the import was stopped; nothing was kept' })
        return true
      }
      return null
    })
    render(<CoworkBundleImport destination="C:/dest" session="s1" pickFolder={async () => 'C:/b'} />)
    await userEvent.click(await screen.findByTestId('bundle-import'))
    await userEvent.click(await screen.findByTestId('bundle-import-cancel'))
    expect(await screen.findByTestId('bundle-import-error')).toHaveAttribute('data-kind', 'cancelled')
    expect(calls('agent_bundle_import_cancel')[0][1]).toEqual({ token: calls('agent_bundle_import')[0][1].token })
  })

  it('lists a pending import with where it came from, and applies through the import', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_bundle_imports_list') return [view()]
      if (cmd === 'agent_proposal_list') return [proposal]
      if (cmd === 'agent_bundle_apply') return { proposalId: 'prop-1', state: 'applied', filesWritten: 1 }
      return null
    })
    render(<CoworkBundleImport destination="C:/dest" session="s1" pickFolder={async () => null} />)
    const row = await screen.findByTestId('bundle-import-row')
    expect(row).toHaveAttribute('data-state', 'pending')
    expect(screen.getByTestId('bundle-import-origin')).toHaveTextContent('jan/cowork/x')
    expect(screen.getByTestId('bundle-import-origin')).toHaveTextContent('0123456789')
    await userEvent.click(screen.getByTestId('bundle-import-review'))
    await userEvent.click(await screen.findByTestId('proposal-apply'))
    await waitFor(() => expect(calls('agent_bundle_apply')).toHaveLength(1))
    expect(calls('agent_proposal_apply')).toHaveLength(0)
    const { approval } = calls('agent_bundle_apply')[0][1]
    expect(approval).toMatchObject({
      importId: 'imp-1',
      bundleSha256: 'f'.repeat(64),
      manifestSha256: 'e'.repeat(64),
      destination: 'C:/dest',
    })
    expect(approval.approval.proposalId).toBe('prop-1')
  })

  it('abandons a pending import', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'agent_bundle_imports_list' ? [view()] : null))
    render(<CoworkBundleImport destination="C:/dest" session="s1" pickFolder={async () => null} />)
    await userEvent.click(await screen.findByTestId('bundle-import-abandon'))
    await waitFor(() => expect(calls('agent_bundle_abandon')).toHaveLength(1))
    expect(calls('agent_bundle_abandon')[0][1]).toEqual({ id: 'imp-1' })
  })
})
