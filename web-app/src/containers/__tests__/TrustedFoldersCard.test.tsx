import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from '@testing-library/react'
import { TrustedFoldersCard } from '../TrustedFoldersCard'
import * as trust from '@/lib/folderTrust'
import { toast } from 'sonner'
import en from '@/locales/en/permissions.json'

const open = vi.fn()
// The real English strings, so the tests read what the person reads.
// A stable `t`, like the real hook's: an unstable one would reload forever.
const t = (key: string, opts?: Record<string, string>) => {
  const path = key.replace('permissions:', '').split('.')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let v: any = en
  for (const p of path) v = v?.[p]
  return String(v ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => opts?.[k] ?? '')
}
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ dialog: () => ({ open }) }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/folderTrust', async (orig) => ({
  ...(await orig<typeof import('@/lib/folderTrust')>()),
  listTrustedFolders: vi.fn(),
  revokeFolderTrust: vi.fn(),
  trustFolder: vi.fn(),
}))

const A = 'C:/code/a-very-long-folder-name/with/many/parts/app'
const B = 'C:/work/site'

describe('TrustedFoldersCard', () => {
  beforeEach(() => {
    vi.mocked(trust.listTrustedFolders).mockReset()
    vi.mocked(trust.revokeFolderTrust).mockReset()
    vi.mocked(trust.trustFolder).mockReset()
    vi.mocked(toast.error).mockReset()
    open.mockReset()
  })

  it('lists every trusted folder', async () => {
    vi.mocked(trust.listTrustedFolders).mockResolvedValue([A, B])
    render(<TrustedFoldersCard />)
    expect(await screen.findAllByTestId('trusted-folder-row')).toHaveLength(2)
    expect(screen.getByText(A)).toBeTruthy()
    expect(screen.getByText(B)).toBeTruthy()
  })

  it('shows the empty state', async () => {
    vi.mocked(trust.listTrustedFolders).mockResolvedValue([])
    render(<TrustedFoldersCard />)
    expect(await screen.findByTestId('trusted-folders-empty')).toBeTruthy()
    expect(screen.queryAllByTestId('trusted-folder-row')).toHaveLength(0)
  })

  it('asks in the page, then revokes and reloads', async () => {
    vi.mocked(trust.listTrustedFolders)
      .mockResolvedValueOnce([A, B])
      .mockResolvedValue([B])
    vi.mocked(trust.revokeFolderTrust).mockResolvedValue({} as never)
    render(<TrustedFoldersCard />)
    const [row] = await screen.findAllByTestId('trusted-folder-row')
    fireEvent.click(
      within(row).getByRole('button', { name: new RegExp(A.replace('.', '\\.')) })
    )
    expect(trust.revokeFolderTrust).not.toHaveBeenCalled()
    expect(within(row).getByRole('alert')).toBeTruthy()
    fireEvent.click(within(row).getByText('Stop trusting'))
    await waitFor(() => expect(trust.revokeFolderTrust).toHaveBeenCalledWith(A))
    await waitFor(() =>
      expect(screen.getAllByTestId('trusted-folder-row')).toHaveLength(1)
    )
  })

  it('cancel leaves the folder trusted', async () => {
    vi.mocked(trust.listTrustedFolders).mockResolvedValue([A])
    render(<TrustedFoldersCard />)
    const row = await screen.findByTestId('trusted-folder-row')
    fireEvent.click(within(row).getByRole('button'))
    fireEvent.click(within(row).getByText('Cancel'))
    expect(trust.revokeFolderTrust).not.toHaveBeenCalled()
    expect(within(row).queryByRole('alert')).toBeNull()
  })

  it('trusts a picked folder and reloads', async () => {
    vi.mocked(trust.listTrustedFolders)
      .mockResolvedValueOnce([])
      .mockResolvedValue([B])
    vi.mocked(trust.trustFolder).mockResolvedValue({} as never)
    open.mockResolvedValue(B)
    render(<TrustedFoldersCard />)
    await screen.findByTestId('trusted-folders-empty')
    fireEvent.click(screen.getByText('Trust a folder…'))
    await waitFor(() => expect(trust.trustFolder).toHaveBeenCalledWith(B))
    expect(await screen.findByText(B)).toBeTruthy()
  })

  it('does nothing when the picker is cancelled', async () => {
    vi.mocked(trust.listTrustedFolders).mockResolvedValue([])
    open.mockResolvedValue(null)
    render(<TrustedFoldersCard />)
    await screen.findByTestId('trusted-folders-empty')
    fireEvent.click(screen.getByText('Trust a folder…'))
    await waitFor(() => expect(open).toHaveBeenCalled())
    expect(trust.trustFolder).not.toHaveBeenCalled()
  })

  it('toasts when trusting, revoking or listing fails', async () => {
    vi.mocked(trust.listTrustedFolders).mockResolvedValue([A])
    vi.mocked(trust.trustFolder).mockRejectedValue(new Error('denied'))
    vi.mocked(trust.revokeFolderTrust).mockRejectedValue(new Error('locked'))
    open.mockResolvedValue(B)
    render(<TrustedFoldersCard />)
    const row = await screen.findByTestId('trusted-folder-row')
    fireEvent.click(screen.getByText('Trust a folder…'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('denied'))
    )
    fireEvent.click(within(row).getByRole('button'))
    fireEvent.click(within(row).getByText('Stop trusting'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('locked'))
    )

    vi.mocked(trust.listTrustedFolders).mockRejectedValue(
      new Error('unreadable')
    )
    render(<TrustedFoldersCard />)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('unreadable')
      )
    )
  })
})
