/**
 * The export surface (AH-177): metadata only unless content is ticked, a
 * warning beside that choice, a typed refusal shown, a running export that
 * can be stopped, and an export read back through the inspector.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))

import { CoworkEventExport } from '../CoworkEventExport'

const manifest = {
  schemaVersion: 1,
  kind: 'jan-event-export',
  envelopeVersion: 1,
  session: 's1',
  run: null,
  metadataOnly: true,
  count: 4,
  firstSeq: 1,
  lastSeq: 4,
  eventsSha256: 'a'.repeat(64),
  createdAt: 't',
  note: '',
}

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd)

beforeEach(() => invoke.mockReset())

describe('CoworkEventExport', () => {
  it('exports metadata only unless content is asked for, and warns when it is', async () => {
    invoke.mockResolvedValue({ path: 'C:/data/exports/events-1', manifest })
    render(<CoworkEventExport sessionId="s1" pickFolder={async () => null} />)
    expect(screen.queryByTestId('event-export-warning')).toBeNull()
    await userEvent.click(screen.getByTestId('event-export-run'))
    await waitFor(() => expect(calls('agent_events_export')).toHaveLength(1))
    expect(calls('agent_events_export')[0][1]).toMatchObject({ session: 's1', includeContent: false })
    expect(await screen.findByTestId('event-export-path')).toHaveAttribute('data-metadata-only', 'true')

    await userEvent.click(screen.getByTestId('event-export-content'))
    expect(screen.getByTestId('event-export-warning')).toHaveTextContent(/share it with care/i)
    await userEvent.click(screen.getByTestId('event-export-run'))
    await waitFor(() => expect(calls('agent_events_export')).toHaveLength(2))
    expect(calls('agent_events_export')[1][1]).toMatchObject({ includeContent: true })
  })

  it('shows a typed refusal, and can stop a running export', async () => {
    let fail: (e: unknown) => void = () => {}
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'agent_events_export') return new Promise((_, reject) => (fail = reject))
      if (cmd === 'agent_events_export_cancel') {
        fail({ kind: 'cancelled', message: 'the export was stopped; nothing was kept' })
        return Promise.resolve(true)
      }
      return Promise.resolve(null)
    })
    render(<CoworkEventExport sessionId="s1" pickFolder={async () => null} />)
    await userEvent.click(screen.getByTestId('event-export-run'))
    await userEvent.click(await screen.findByTestId('event-export-cancel'))
    expect(await screen.findByTestId('event-export-error')).toHaveAttribute('data-kind', 'cancelled')
    expect(calls('agent_events_export_cancel')[0][1].token).toBe(calls('agent_events_export')[0][1].token)
  })

  it('reads an export back through the inspector and shows a damaged one as typed', async () => {
    invoke.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd !== 'agent_events_inspect') return null
      if (args.path === 'C:/bad') throw { kind: 'hash-mismatch', message: 'events.jsonl does not match the manifest' }
      return { manifest, kinds: { 'run.started': 1, 'tool.succeeded': 2, 'run.ended': 1 }, unknownKinds: 0 }
    })
    const { rerender } = render(<CoworkEventExport sessionId="s1" pickFolder={async () => 'C:/good'} />)
    await userEvent.click(screen.getByTestId('event-inspect'))
    const summary = await screen.findByTestId('event-inspect-summary')
    expect(summary).toHaveAttribute('data-count', '4')
    expect(summary).toHaveTextContent('tool.succeeded: 2')
    rerender(<CoworkEventExport sessionId="s1" pickFolder={async () => 'C:/bad'} />)
    await userEvent.click(screen.getByTestId('event-inspect'))
    expect(await screen.findByTestId('event-export-error')).toHaveAttribute('data-kind', 'hash-mismatch')
  })
})
