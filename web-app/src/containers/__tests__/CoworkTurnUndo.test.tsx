/**
 * Undo/redo by turn (AH-202): what the control offers, what it asks the
 * backend for, and that a refusal is announced rather than swallowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  undoJournal: vi.fn(),
  undoTurn: vi.fn(),
  redoTurn: vi.fn(),
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => api)
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o ? `${k} ${JSON.stringify(o)}` : k,
  }),
}))

import { CoworkTurnUndo } from '../CoworkTurnUndo'

const journal = [
  { run: 'run-1', at: 't1', state: 'applied', paths: ['C:/ws/a.txt'] },
  { run: 'run-2', at: 't2', state: 'undone', paths: ['C:/ws/b.txt'] },
]

beforeEach(() => {
  vi.clearAllMocks()
  api.undoJournal.mockResolvedValue(journal)
  api.undoTurn.mockResolvedValue({ run: 'run-1', state: 'undone', files: 1 })
  api.redoTurn.mockResolvedValue({ run: 'run-2', state: 'applied', files: 1 })
})

const mount = (extra = {}) =>
  render(
    <CoworkTurnUndo
      dataFolder="/data"
      sessionId="s1"
      writeGrant="grant-1"
      {...extra}
    />
  )

describe('CoworkTurnUndo', () => {
  it('lists each turn newest first, offering undo or redo by its state', async () => {
    mount()
    const rows = await screen.findAllByTestId('turn-undo-row')
    expect(rows.map((r) => r.getAttribute('data-run'))).toEqual([
      'run-2',
      'run-1',
    ])
    expect(rows[0].querySelector('[data-testid="turn-redo"]')).not.toBeNull()
    expect(
      rows[1].querySelector('[data-testid="turn-undo-button"]')
    ).not.toBeNull()
  })

  it('undoes one turn with the session grant and announces the result', async () => {
    const onChanged = vi.fn()
    mount({ onChanged })
    const rows = await screen.findAllByTestId('turn-undo-row')
    await userEvent.click(
      rows[1].querySelector('[data-testid="turn-undo-button"]') as HTMLElement
    )
    await waitFor(() => expect(api.undoTurn).toHaveBeenCalled())
    expect(api.undoTurn).toHaveBeenCalledWith('/data', 's1', 'run-1', {
      writeGrant: 'grant-1',
      scope: 'session',
    })
    expect(await screen.findByTestId('turn-undo-status')).toHaveTextContent(
      'common:turnUndo.undone'
    )
    expect(onChanged).toHaveBeenCalled()
  })

  it('announces a refusal, naming what the backend named, and changes nothing', async () => {
    api.undoTurn.mockRejectedValue(
      'a file changed since, so nothing was changed: C:/ws/a.txt'
    )
    const onChanged = vi.fn()
    mount({ onChanged })
    const rows = await screen.findAllByTestId('turn-undo-row')
    await userEvent.click(
      rows[1].querySelector('[data-testid="turn-undo-button"]') as HTMLElement
    )
    const status = await screen.findByRole('alert')
    expect(status).toHaveTextContent('nothing was changed: C:/ws/a.txt')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('redoes an undone turn', async () => {
    mount()
    const rows = await screen.findAllByTestId('turn-undo-row')
    await userEvent.click(
      rows[0].querySelector('[data-testid="turn-redo"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.redoTurn).toHaveBeenCalledWith('/data', 's1', 'run-2', {
        writeGrant: 'grant-1',
        scope: 'session',
      })
    )
  })

  it('every control has an accessible name that says which turn it acts on', async () => {
    mount()
    await screen.findAllByTestId('turn-undo-row')
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('aria-label')).toMatch(/turnUndo\.(undo|redo)/)
    }
  })

  /// The regression: an answer that was not a list crashed the whole Cowork
  /// page, because the panel read `.length` of whatever came back.
  it('renders nothing, and does not throw, when the backend answers oddly', async () => {
    api.undoJournal.mockResolvedValue(undefined)
    const { container } = mount()
    await waitFor(() => expect(api.undoJournal).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="turn-undo"]')).toBeNull()
  })

  it('renders nothing when no turn changed a file', async () => {
    api.undoJournal.mockResolvedValue([])
    const { container } = mount()
    await waitFor(() => expect(api.undoJournal).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="turn-undo"]')).toBeNull()
  })
})
