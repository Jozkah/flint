import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { FolderTrustBanner } from '../FolderTrustBanner'
import * as trust from '@/lib/folderTrust'

vi.mock('@/lib/folderTrust', async (orig) => ({
  ...(await orig<typeof import('@/lib/folderTrust')>()),
  folderTrustStatus: vi.fn(),
  trustFolder: vi.fn(),
}))

const untrusted = (carries = { hooks: true, subagents: false }) => ({
  folder: 'C:/code/app',
  trusted: false,
  carries,
})

describe('FolderTrustBanner', () => {
  beforeEach(() => {
    vi.mocked(trust.folderTrustStatus).mockReset()
    vi.mocked(trust.trustFolder).mockReset()
  })

  it('asks about an untrusted folder that carries hooks', async () => {
    vi.mocked(trust.folderTrustStatus).mockResolvedValue(untrusted())
    render(<FolderTrustBanner folder="C:/code/app" />)
    expect(await screen.findByTestId('folder-trust-banner')).toBeTruthy()
  })

  it('stays quiet for a folder with nothing to run, or one already trusted', async () => {
    vi.mocked(trust.folderTrustStatus).mockResolvedValue(untrusted({ hooks: false, subagents: false }))
    const { rerender } = render(<FolderTrustBanner folder="C:/code/quiet" />)
    await waitFor(() => expect(trust.folderTrustStatus).toHaveBeenCalled())
    expect(screen.queryByTestId('folder-trust-banner')).toBeNull()

    vi.mocked(trust.folderTrustStatus).mockResolvedValue({ ...untrusted(), trusted: true })
    rerender(<FolderTrustBanner folder="C:/code/trusted" />)
    await waitFor(() => expect(trust.folderTrustStatus).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('folder-trust-banner')).toBeNull()
  })

  it('trusting once hides it for good', async () => {
    vi.mocked(trust.folderTrustStatus).mockResolvedValue(untrusted())
    vi.mocked(trust.trustFolder).mockResolvedValue({ ...untrusted(), trusted: true })
    render(<FolderTrustBanner folder="C:/code/grant" />)
    fireEvent.click(await screen.findByTestId('folder-trust-grant'))
    await waitFor(() => expect(screen.queryByTestId('folder-trust-banner')).toBeNull())
    expect(trust.trustFolder).toHaveBeenCalledWith('C:/code/grant')
  })

  it('"Not now" hides it without trusting', async () => {
    vi.mocked(trust.folderTrustStatus).mockResolvedValue(untrusted())
    render(<FolderTrustBanner folder="C:/code/later" />)
    await screen.findByTestId('folder-trust-banner')
    fireEvent.click(screen.getAllByRole('button')[0])
    await waitFor(() => expect(screen.queryByTestId('folder-trust-banner')).toBeNull())
    expect(trust.trustFolder).not.toHaveBeenCalled()
  })
})

describe('FolderTrustBanner with a backend that gives no status', () => {
  it('stays quiet instead of failing', async () => {
    const real = await vi.importActual<typeof import('@/lib/folderTrust')>('@/lib/folderTrust')
    expect(await real.folderTrustStatus('C:/x', async () => undefined)).toBeNull()
    expect(await real.folderTrustStatus('C:/x', async () => ({}))).toBeNull()
    expect(await real.folderTrustStatus('C:/x', async () => { throw new Error('no') })).toBeNull()
    expect(real.needsTrustDecision(null)).toBe(false)
  })
})
