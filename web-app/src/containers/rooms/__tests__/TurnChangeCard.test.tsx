import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TurnChangeCard } from '../TurnChangeCard'
import type { RoomTurnChanges } from '@/lib/rooms/types'

const t = (key: string, o?: Record<string, unknown>) => (o ? `${key}:${JSON.stringify(o)}` : key)

const changes: RoomTurnChanges = {
  files: [{ path: 'b.ts', additions: 1, deletions: 0 }],
  workspace: 'C:/ws/p-a',
  cumulative: [
    { path: 'a.ts', additions: 3, deletions: 1 },
    { path: 'b.ts', additions: 1, deletions: 0 },
  ],
}
const actions = { patch: vi.fn(async () => ''), discard: vi.fn(async () => {}), apply: vi.fn(async () => 1) }

const open = () => fireEvent.click(screen.getAllByRole('button')[0])

describe('TurnChangeCard', () => {
  it('shows a saved decision after a reload and hides Keep', () => {
    render(<TurnChangeCard changes={changes} actions={actions} decision="kept" t={t} />)
    expect(screen.getByText('rooms:changes.state.kept')).toBeTruthy()
    open()
    expect(screen.queryByText('rooms:changes.keep')).toBeNull()
  })

  it('saves Keep through onDecision', () => {
    const onDecision = vi.fn()
    render(<TurnChangeCard changes={changes} actions={actions} onDecision={onDecision} t={t} />)
    open()
    fireEvent.click(screen.getByText('rooms:changes.keep'))
    expect(onDecision).toHaveBeenCalledWith('kept')
  })

  it('a discarded change shows no actions after a reload', () => {
    render(<TurnChangeCard changes={changes} actions={actions} decision="discarded" t={t} />)
    open()
    expect(screen.queryByText('rooms:changes.apply')).toBeNull()
    expect(screen.queryByText('rooms:changes.discard')).toBeNull()
  })

  it('shows this turn by default and the cumulative change on the toggle', () => {
    render(<TurnChangeCard changes={changes} actions={actions} t={t} />)
    open()
    expect(screen.queryByText('a.ts')).toBeNull()
    expect(screen.getByText('b.ts')).toBeTruthy()
    fireEvent.click(screen.getByText('rooms:changes.scopeAll'))
    expect(screen.getByText('a.ts')).toBeTruthy()
  })
})
