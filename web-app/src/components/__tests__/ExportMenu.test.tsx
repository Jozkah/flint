import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/exportRender', () => ({
  printDocument: vi.fn().mockResolvedValue(undefined),
  renderPng: vi.fn(),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o ? `${k}:${JSON.stringify(o)}` : k,
  }),
}))

import {
  DropdownMenu,
  DropdownMenuContent,
} from '@/components/ui/dropdown-menu'
import { ExportItems } from '../ExportMenu'
import type { ExportDoc } from '@/lib/exportMarkdown'

const doc: ExportDoc = {
  title: 'Chat',
  scope: 'thread',
  exportedAt: '2026-10-01T10:00:00.000Z',
  messages: [{ role: 'user', text: 'hi' }],
}

const renderMenu = (build = () => doc) =>
  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <ExportItems build={build} />
      </DropdownMenuContent>
    </DropdownMenu>
  )

beforeEach(() => {
  invoke.mockReset()
  toast.success.mockReset()
  toast.error.mockReset()
})

describe('ExportItems', () => {
  it('offers every format', () => {
    renderMenu()
    for (const id of ['markdown', 'markdown-full', 'obsidian', 'pdf', 'image']) {
      expect(screen.getByTestId(`export-${id}`)).toBeTruthy()
    }
  })

  it('saves Markdown through export_save_file and confirms with the path', async () => {
    invoke.mockResolvedValue({ path: 'C:\\x\\Chat.md', redactions: 0 })
    renderMenu()
    await userEvent.click(screen.getByTestId('export-markdown'))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(invoke).toHaveBeenCalledWith(
      'export_save_file',
      expect.objectContaining({ ext: 'md', suggestedName: 'Chat.md' })
    )
    expect(toast.success.mock.calls[0][0]).toContain('C:\\\\x\\\\Chat.md')
  })

  it('says nothing when the save dialog is cancelled', async () => {
    invoke.mockResolvedValue(null)
    renderMenu()
    await userEvent.click(screen.getByTestId('export-obsidian'))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    await Promise.resolve()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows the reason when the backend refuses', async () => {
    invoke.mockRejectedValue('exports can be saved as md, pdf or png')
    renderMenu()
    await userEvent.click(screen.getByTestId('export-markdown'))
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error.mock.calls[0][0]).toContain('exports can be saved')
  })

  it('tells the user when there is nothing to export', async () => {
    renderMenu(() => null as unknown as ExportDoc)
    await userEvent.click(screen.getByTestId('export-markdown'))
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(invoke).not.toHaveBeenCalled()
  })

  it('PDF opens the print dialog and does not call the backend', async () => {
    renderMenu()
    await userEvent.click(screen.getByTestId('export-pdf'))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(invoke).not.toHaveBeenCalled()
    expect(toast.success.mock.calls[0][0]).toContain('export.printOpened')
  })
})
