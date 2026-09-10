import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const core = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => core)

import { CoworkHandoffNotice } from '../CoworkHandoffNotice'
import type { HandoffRecord } from '@/lib/sessionHandoff'

const expected = { name: 'widget', branch: 'main', head: 'abcdef1234567890' }
const record: HandoffRecord = {
  info: { folder: expected, model: { provider: 'openrouter', id: 'gpt-x' } },
  unrestored: [
    { kind: 'folder', expected },
    { kind: 'model', provider: 'openrouter', id: 'gpt-x' },
  ],
}

beforeEach(() => {
  core.invoke.mockReset()
})

describe('CoworkHandoffNotice (AH-210)', () => {
  it('says, item by item, what could not be restored', () => {
    render(
      <CoworkHandoffNotice handoff={record} folder={null} onDismiss={vi.fn()} />
    )
    expect(screen.getByTestId('handoff-item-folder')).toHaveTextContent(
      'a folder named widget (branch main at commit abcdef123456)'
    )
    expect(screen.getByTestId('handoff-item-model')).toHaveTextContent(
      'The model gpt-x is not available from openrouter'
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('checks an attached folder against the one the session worked in', async () => {
    core.invoke.mockResolvedValue({ ...expected })
    render(
      <CoworkHandoffNotice
        handoff={record}
        folder="/here/widget"
        onDismiss={vi.fn()}
      />
    )
    expect(await screen.findByTestId('handoff-folder-check')).toHaveTextContent(
      'matches the one the session worked in'
    )
    expect(core.invoke).toHaveBeenCalledWith('session_folder_identity', {
      folder: '/here/widget',
    })
    expect(screen.queryByTestId('handoff-item-folder')).toBeNull()
  })

  it('names how a different folder differs', async () => {
    core.invoke.mockResolvedValue({ ...expected, branch: 'dev' })
    render(
      <CoworkHandoffNotice
        handoff={record}
        folder="/here/widget"
        onDismiss={vi.fn()}
      />
    )
    expect(await screen.findByTestId('handoff-folder-check')).toHaveTextContent(
      'it is on branch dev, not main'
    )
  })

  it('goes away when dismissed, and stays away', async () => {
    const onDismiss = vi.fn()
    const { rerender } = render(
      <CoworkHandoffNotice
        handoff={record}
        folder={null}
        onDismiss={onDismiss}
      />
    )
    await userEvent.click(screen.getByTestId('handoff-dismiss'))
    expect(onDismiss).toHaveBeenCalled()
    rerender(
      <CoworkHandoffNotice
        handoff={{ ...record, dismissed: true }}
        folder={null}
        onDismiss={onDismiss}
      />
    )
    expect(screen.queryByTestId('handoff-notice')).toBeNull()
  })

  it('shows nothing for a session that was not handed off', () => {
    const { container } = render(
      <CoworkHandoffNotice
        handoff={undefined}
        folder={null}
        onDismiss={vi.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
