import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const info = vi.fn()
const list = vi.fn()
vi.mock('@/lib/remoteCowork', () => ({ runnerInfo: () => info() }))
vi.mock('@/lib/remoteRunner', () => ({
  listAgentFolders: (path?: string | null) => list(path ?? null),
}))
vi.mock('@/hooks/useMediaQuery', () => ({ useSmallScreen: () => false }))

import { ServerFolderPickerHost } from '../ServerFolderChooser'
import { displayPath, pickServerFolder, useServerFolderPicker } from '@/lib/serverFolderPicker'

const ROOT = 'C:\\work'
const APP = 'C:\\work\\app'

beforeEach(() => {
  info.mockReset()
  list.mockReset()
  useServerFolderPicker.setState({ open: false, resolve: null })
  info.mockResolvedValue({ agent: true })
  list.mockImplementation(async (path: string | null) =>
    path === null
      ? { path: null, parent: null, entries: [{ name: 'work', path: ROOT, git: false }] }
      : path === ROOT
        ? { path: ROOT, parent: null, entries: [{ name: 'app', path: APP, git: true }] }
        : { path, parent: ROOT, entries: [] }
  )
})

describe('server folder chooser', () => {
  it('browses the server roots and resolves with the chosen folder', async () => {
    render(<ServerFolderPickerHost />)
    let picked: Promise<string | null> = Promise.resolve(null)
    act(() => {
      picked = pickServerFolder()
    })
    const root = await screen.findByText(ROOT)
    fireEvent.click(root)
    fireEvent.click(await screen.findByText('app'))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(APP))
    await waitFor(() =>
      expect(screen.getByTestId('server-folder-choose')).not.toBeDisabled()
    )
    fireEvent.click(screen.getByTestId('server-folder-choose'))
    await expect(picked).resolves.toBe(APP)
    expect(useServerFolderPicker.getState().open).toBe(false)
  })

  it('cannot choose until a folder is open, and Cancel resolves null', async () => {
    render(<ServerFolderPickerHost />)
    let picked: Promise<string | null> = Promise.resolve('x')
    act(() => {
      picked = pickServerFolder()
    })
    await screen.findByText(ROOT)
    expect(screen.getByTestId('server-folder-choose')).toBeDisabled()
    fireEvent.click(screen.getByText('common:cancel'))
    await expect(picked).resolves.toBeNull()
  })

  it('says how to share folders when the server has no --agent-root', async () => {
    info.mockResolvedValue({ agent: false })
    render(<ServerFolderPickerHost />)
    act(() => {
      void pickServerFolder()
    })
    expect(await screen.findByTestId('server-folder-off')).toHaveTextContent(
      'integrations:serverFolders.off'
    )
    expect(list).not.toHaveBeenCalled()
  })

  it('moves with the keyboard: Right opens, Left goes up', async () => {
    render(<ServerFolderPickerHost />)
    act(() => {
      void pickServerFolder()
    })
    const root = await screen.findByText(ROOT)
    const listbox = screen.getByRole('listbox')
    ;(root.closest('button') as HTMLButtonElement).focus()
    fireEvent.keyDown(listbox, { key: 'ArrowRight' })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(ROOT))
    await screen.findByText('app')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowLeft' })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(null))
  })

  it('shows Windows canonical paths without the verbatim prefix', () => {
    expect(displayPath('\\\\?\\C:\\work')).toBe('C:\\work')
    expect(displayPath('/srv/work')).toBe('/srv/work')
  })

  it('keeps the Up row after a folder fails to open (W03)', async () => {
    const BAD = 'C:\work\pct%20dir'
    list.mockImplementation(async (path: string | null) =>
      path === null
        ? { path: null, parent: null, entries: [{ name: 'work', path: ROOT, git: false }] }
        : path === ROOT
          ? { path: ROOT, parent: null, entries: [{ name: 'pct%20dir', path: BAD, git: false }] }
          : Promise.reject(new Error('invalid path'))
    )
    render(<ServerFolderPickerHost />)
    act(() => {
      void pickServerFolder()
    })
    fireEvent.click(await screen.findByText(ROOT))
    fireEvent.click(await screen.findByText('pct%20dir'))
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid path')
    fireEvent.click(screen.getByTestId('server-folder-up'))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(ROOT))
    expect(await screen.findByText('pct%20dir')).toBeInTheDocument()
  })
})
