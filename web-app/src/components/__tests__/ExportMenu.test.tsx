import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/exportRender', () => ({
  printDocument: vi.fn().mockResolvedValue('printed'),
  renderPng: vi.fn(),
  renderHtmlPage: () => '<html></html>',
  currentPdfStrategy: () => 'print',
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
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { ExportDoc } from '@/lib/exportMarkdown'

const doc: ExportDoc = {
  title: 'Chat',
  scope: 'thread',
  exportedAt: '2026-10-01T10:00:00.000Z',
  messages: [{ role: 'user', text: 'hi' }],
}

const renderMenu = (build: (o: { allVersions: boolean }) => ExportDoc = () => doc, versions = false) =>
  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <ExportItems build={build} versions={versions} />
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

  it('offers the all-versions entries only where asked for', () => {
    renderMenu()
    expect(screen.queryByTestId('export-markdown-versions')).toBeNull()
  })

  it('passes allVersions to the builder', async () => {
    invoke.mockResolvedValue(null)
    const build = vi.fn((_o: { allVersions: boolean }) => doc)
    renderMenu(build, true)
    await userEvent.click(screen.getByTestId('export-markdown-versions'))
    await vi.waitFor(() =>
      expect(build).toHaveBeenCalledWith({ allVersions: true })
    )
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

describe('ExportItems extra entries', () => {
  it('places the extra entry after the formats', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <ExportItems
            build={() => doc}
            extra={<DropdownMenuItem data-testid="export-session">bundle</DropdownMenuItem>}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    )
    const items = screen.getAllByRole('menuitem').map((e) => e.getAttribute('data-testid'))
    expect(items.at(-1)).toBe('export-session')
    expect(items).toContain('export-image')
  })
})

describe('the Cowork row menu', () => {
  const src = readFileSync(
    resolve(__dirname, '../shell/nav/CoworkNav.tsx'),
    'utf8'
  )

  it('keeps the session bundle inside the Export submenu, not beside it', () => {
    const menu = src.slice(src.indexOf('<ExportSubmenu'))
    // The bundle entry sits in the submenu's `extra`, before the next menu item.
    expect(menu.indexOf('data-testid="export-session"')).toBeGreaterThan(-1)
    expect(menu.indexOf('data-testid="export-session"')).toBeLessThan(
      menu.indexOf('data-testid="handoff-session"')
    )
    // One entry only, and it is the submenu's.
    expect(src.match(/data-testid="export-session"/g)).toHaveLength(1)
    expect(src.slice(0, src.indexOf('<ExportSubmenu'))).not.toContain(
      'data-testid="export-session"'
    )
    expect(src).not.toContain("common:exportSession')")
  })

  it('has the label in English', () => {
    const en = JSON.parse(
      readFileSync(resolve(__dirname, '../../locales/en/common.json'), 'utf8')
    )
    expect(en.exportSessionBundle).toBe('Session bundle (JSON)')
    expect(en.exportSession).toBeUndefined()
  })
})
