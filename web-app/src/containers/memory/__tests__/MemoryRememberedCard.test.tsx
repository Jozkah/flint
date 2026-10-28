/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

import { MemoryRememberedCard } from '../MemoryRememberedCard'

const row = (id: string) => ({ id, content: id, preview: id, pinned: false, status: 'active', origin: 'explicit', creator: 'u', useCount: 0, lastUsedAt: null, createdAt: 1, updatedAt: 1, redacted: false, uses: [], history: [], scope: 'user' })

const props = (over: Record<string, unknown> = {}) =>
  ({
    scope: 'user',
    tabCount: () => 2,
    setScope: vi.fn(),
    setOffset: vi.fn(),
    scopeKey: 'settings:memoryPage.scope.user',
    recall: { session: true, project: true, user: false },
    onAdd: vi.fn(async () => {}),
    newMemory: 'remember me',
    setNewMemory: vi.fn(),
    busy: false,
    location: { dataFolder: '/d' },
    total: 2,
    onExport: vi.fn(async () => {}),
    onImport: vi.fn(async () => {}),
    importReport: null,
    importCount: 0,
    sessionId: undefined,
    setSessionId: vi.fn(),
    conversations: { sessions: [], projects: [] },
    projectRoot: undefined,
    setProjectRoot: vi.fn(),
    setProjectId: vi.fn(),
    projectId: '',
    projects: [],
    query: '',
    setQuery: vi.fn(),
    unavailable: null,
    page: [row('m1'), row('m2')],
    onTogglePin: vi.fn(),
    setEditing: vi.fn(),
    setDraft: vi.fn(),
    onForget: vi.fn(),
    offset: 0,
    setClearing: vi.fn(),
    ...over,
  }) as any

describe('MemoryRememberedCard', () => {
  it('lists the page of records', () => {
    render(<MemoryRememberedCard {...props()} />)
    expect(screen.getAllByTestId('memory-row')).toHaveLength(2)
  })

  it('switching scope resets the paging', async () => {
    const p = props()
    render(<MemoryRememberedCard {...p} />)
    await userEvent.click(screen.getAllByRole('tab')[0])
    expect(p.setScope).toHaveBeenCalledWith('chat')
    expect(p.setOffset).toHaveBeenCalledWith(0)
  })

  it('warns when recall is off for the shown scope', () => {
    render(<MemoryRememberedCard {...props()} />)
    expect(screen.getByTestId('memory-recall-off-note')).toBeTruthy()
  })

  it('saves the new memory on submit and not while empty or busy', async () => {
    const p = props()
    const { unmount } = render(<MemoryRememberedCard {...p} />)
    await userEvent.click(screen.getByTestId('memory-new-save'))
    expect(p.onAdd).toHaveBeenCalledTimes(1)
    unmount()
    render(<MemoryRememberedCard {...props({ newMemory: ' ' })} />)
    expect((screen.getByTestId('memory-new-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('export needs records, import needs a location', () => {
    render(<MemoryRememberedCard {...props({ total: 0, location: null })} />)
    expect((screen.getByTestId('memory-export') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('memory-import') as HTMLButtonElement).disabled).toBe(true)
  })

  it('asks to forget the whole scope', async () => {
    const p = props()
    render(<MemoryRememberedCard {...p} />)
    await userEvent.click(screen.getByTestId('memory-clear-scope'))
    expect(p.setClearing).toHaveBeenCalledWith('user')
  })

  it('shows the import report when there is one', () => {
    render(
      <MemoryRememberedCard
        {...props({ importReport: { exportId: 'e', imported: ['a'], duplicates: [], refused: [] } })}
      />
    )
    expect(screen.getByTestId('memory-import-report')).toBeTruthy()
  })
})
