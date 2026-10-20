import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const ws = vi.hoisted(() => ({
  listMemories: vi.fn(),
  readMemory: vi.fn(),
  writeMemory: vi.fn(),
  deleteMemory: vi.fn(),
}))
vi.mock('@/lib/agentWorkspace', () => ws)
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { AgentNotesSettings } from '../AgentNotesSettings'

beforeEach(() => {
  vi.clearAllMocks()
  ws.listMemories.mockResolvedValue(['deploy-steps', 'style'])
  ws.readMemory.mockResolvedValue('use yarn')
  ws.writeMemory.mockResolvedValue(undefined)
  ws.deleteMemory.mockResolvedValue(undefined)
})

describe('AgentNotesSettings', () => {
  it('lists the notes the memory_write tool saved, under the Agent notes title', async () => {
    render(<AgentNotesSettings />)
    expect(await screen.findByText('deploy-steps')).toBeInTheDocument()
    expect(screen.getByText('style')).toBeInTheDocument()
    expect(screen.getByText('Agent notes')).toBeInTheDocument()
  })

  it('deletes a note with an undo that writes it back', async () => {
    render(<AgentNotesSettings />)
    await screen.findByText('deploy-steps')
    fireEvent.click(
      screen.getByRole('button', { name: 'common:delete deploy-steps' })
    )
    await waitFor(() =>
      expect(ws.deleteMemory).toHaveBeenCalledWith('deploy-steps')
    )
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const undo = toast.success.mock.calls[0][1].action.onClick as () => void
    undo()
    await waitFor(() =>
      expect(ws.writeMemory).toHaveBeenCalledWith('deploy-steps', 'use yarn')
    )
  })

  it('refuses to save a new note over an existing name', async () => {
    render(<AgentNotesSettings />)
    await screen.findByText('style')
    fireEvent.click(screen.getByRole('button', { name: 'settings:agentTools.add' }))
    fireEvent.change(
      await screen.findByPlaceholderText('settings:agentTools.namePlaceholder'),
      { target: { value: 'style' } }
    )
    fireEvent.click(screen.getByRole('button', { name: 'common:save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(ws.writeMemory).not.toHaveBeenCalled()
  })
})
