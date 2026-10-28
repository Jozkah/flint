/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

import { MemorySettingsCard } from '../MemorySettingsCard'
import { formatBytes } from '../memoryScopes'

const props = (over: Record<string, unknown> = {}) =>
  ({
    memoryOn: true,
    memoryOnPending: false,
    location: { dataFolder: '/d' },
    onToggleMemory: vi.fn(async () => {}),
    autoSave: false,
    autoSavePending: false,
    onToggleAutoSave: vi.fn(async () => {}),
    recall: { session: true, project: true, user: true },
    onToggleRecall: vi.fn(async () => {}),
    settingsIssue: null,
    summary: { sessionCount: 1, projectCount: 2, userCount: 3, deletedCount: 0, conflictedCount: 0, bytes: 2048 },
    selectedProject: undefined,
    ...over,
  }) as any

describe('MemorySettingsCard', () => {
  it('turns memory on and off through the first switch', async () => {
    const p = props()
    render(<MemorySettingsCard {...p} />)
    const switches = screen.getAllByRole('switch')
    expect(switches[0].getAttribute('aria-checked')).toBe('true')
    await userEvent.click(switches[0])
    expect(p.onToggleMemory).toHaveBeenCalledWith(false)
  })

  it('disables the memory switch until the data location is known', () => {
    render(<MemorySettingsCard {...props({ location: null })} />)
    expect((screen.getAllByRole('switch')[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('toggles auto-save and per-scope recall', async () => {
    const p = props()
    render(<MemorySettingsCard {...p} />)
    const switches = screen.getAllByRole('switch')
    await userEvent.click(switches[1])
    expect(p.onToggleAutoSave).toHaveBeenCalledWith(true)
    await userEvent.click(switches[2])
    expect(p.onToggleRecall).toHaveBeenCalledTimes(1)
  })

  it('shows damaged settings as an alert', () => {
    render(<MemorySettingsCard {...props({ settingsIssue: 'bad json' })} />)
    expect(screen.getByText(/bad json/)).toBeTruthy()
  })
})

describe('formatBytes', () => {
  it('uses the largest whole unit', () => {
    expect(formatBytes(10)).toBe('10 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
