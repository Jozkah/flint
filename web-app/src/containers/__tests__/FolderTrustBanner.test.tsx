import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

  it('is a full-width bar, not a centred card, so it can sit over the composer', async () => {
    vi.mocked(trust.folderTrustStatus).mockResolvedValue(untrusted())
    render(<FolderTrustBanner folder="C:/code/app" />)
    const banner = await screen.findByTestId('folder-trust-banner')
    expect(banner.className).not.toMatch(/mx-auto|max-w-3xl|(^|\s)my-2(\s|$)/)
    expect(banner.className).toContain('mb-1.5')
  })

  it('is mounted over the composers, not in the transcript or the page header', () => {
    const src = (p: string) => readFileSync(resolve(__dirname, p), 'utf8')
    const chat = src('../ThreadConversation.tsx')
    expect(chat.indexOf('<FolderTrustBanner')).toBeGreaterThan(chat.indexOf('Chat Input - Fixed at bottom'))
    const cowork = src('../../routes/cowork.tsx')
    const at = cowork.indexOf('<FolderTrustBanner')
    const stack = cowork.indexOf('<CoworkBarStack')
    // Directly above the bar stack that sits over the composer.
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(stack)
    expect(stack - at).toBeLessThan(400)
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
    fireEvent.click(screen.getByTestId('folder-trust-later'))
    await waitFor(() => expect(screen.queryByTestId('folder-trust-banner')).toBeNull())
    expect(trust.trustFolder).not.toHaveBeenCalled()
  })
})

describe('FolderTrustBanner as one row', () => {
  beforeEach(() => {
    vi.mocked(trust.folderTrustStatus).mockReset()
  })

  it('shows a one-line summary, not the paragraphs', async () => {
    vi.mocked(trust.folderTrustStatus).mockResolvedValue(untrusted())
    render(<FolderTrustBanner folder="C:/code/app" />)
    const summary = await screen.findByTestId('folder-trust-summary')
    expect(summary).toHaveClass('text-fade')
    expect(summary.textContent).toBe('permissions:folderTrust.summaryHooks')
    const banner = screen.getByTestId('folder-trust-banner')
    expect(banner.querySelectorAll('p')).toHaveLength(0)
    expect(banner.querySelector('[data-bar-row]')).toHaveClass('flex-nowrap')
    // Still a warning, and nothing is trusted by showing it.
    expect(banner.querySelector('[data-bar-row]')!.className).toMatch(/border-warning/)
    expect(trust.trustFolder).not.toHaveBeenCalled()
  })

  it('keeps the full explanation behind the info button', async () => {
    vi.mocked(trust.folderTrustStatus).mockResolvedValue(untrusted())
    render(<FolderTrustBanner folder="C:/code/app" />)
    const info = await screen.findByTestId('folder-trust-info')
    expect(info.getAttribute('aria-label')).toBeTruthy()
    fireEvent.click(info)
    const details = await screen.findByTestId('folder-trust-details')
    expect(details.textContent).toContain('permissions:folderTrust.bodyHooks')
    expect(details.textContent).toContain('permissions:folderTrust.keepsOff')
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
