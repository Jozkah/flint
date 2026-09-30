import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    dialog: () => ({
      open: async () => '/usr/bin/brave-browser',
    }),
  }),
}))

const setBrowserPath = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/lib/browserVerify', async (orig) => ({
  ...(await orig<typeof import('@/lib/browserVerify')>()),
  setBrowserPath,
}))

import { BrowserVerifyPanel, BrowserVerifyEvidence } from '../BrowserVerifyPanel'
import { useBrowserVerify } from '@/hooks/useBrowserVerify'
import type { VerifyReport } from '@/lib/browserVerify'

const found = async () => ({ found: true, path: '/usr/bin/chromium', name: 'Chromium', hint: null })

describe('BrowserVerifyPanel', () => {
  beforeEach(() => useBrowserVerify.setState({ running: {}, reports: {}, draftUrl: null }))

  it('explains a missing browser and offers to choose one', async () => {
    render(
      <BrowserVerifyPanel
        sessionId="s1"
        detect={async () => ({ found: false, path: null, name: null, hint: 'Install a Chromium-based browser.' })}
      />
    )
    expect((await screen.findByTestId('bv-no-browser')).textContent).toContain(
      'Install a Chromium-based browser.'
    )
    expect(screen.getByTestId('bv-choose-browser')).toBeTruthy()
    expect((screen.getByTestId('bv-run') as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers a Choose button when no browser is found', async () => {
    render(
      <BrowserVerifyPanel
        sessionId="s1"
        detect={async () => ({ found: false, path: null, name: null, hint: 'No browser found.' })}
      />
    )
    await screen.findByTestId('bv-no-browser')
    expect(screen.getByTestId('bv-choose-browser')).toBeTruthy()
  })

  it('surfaces a refused browser path instead of swallowing it', async () => {
    setBrowserPath.mockRejectedValueOnce(new Error('must be absolute'))
    render(
      <BrowserVerifyPanel
        sessionId="s1"
        detect={async () => ({ found: false, path: null, name: null, hint: null })}
      />
    )
    fireEvent.click(await screen.findByTestId('bv-choose-browser'))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('must be absolute'))
  })

  it('offers a different browser even when one is already found', async () => {
    setBrowserPath.mockResolvedValueOnce({ found: true, path: '/usr/bin/brave-browser', name: 'Brave', hint: null })
    render(<BrowserVerifyPanel sessionId="s1" detect={found} />)
    fireEvent.click(await screen.findByTestId('bv-choose-other-browser'))
    await waitFor(() => expect(screen.getByText('common:browserVerify.using')).toBeTruthy())
    expect(setBrowserPath).toHaveBeenCalledWith('/usr/bin/brave-browser')
  })

  it('will not run against a URL that is not on this machine', async () => {
    render(<BrowserVerifyPanel sessionId="s1" detect={found} />)
    fireEvent.change(screen.getByTestId('bv-url'), { target: { value: 'https://example.com' } })
    await waitFor(() => expect(screen.getByText('common:browserVerify.notLocal')).toBeTruthy())
    expect((screen.getByTestId('bv-run') as HTMLButtonElement).disabled).toBe(true)
  })

  it('takes the URL handed over from the web preview, and starts with the parsed steps', async () => {
    const start = vi.fn(async () => ({}) as VerifyReport)
    useBrowserVerify.setState({ draftUrl: 'http://127.0.0.1:3000/', start })
    render(<BrowserVerifyPanel sessionId="s1" detect={found} />)
    await waitFor(() =>
      expect((screen.getByTestId('bv-url') as HTMLInputElement).value).toBe('http://127.0.0.1:3000/')
    )
    fireEvent.change(screen.getByTestId('bv-steps-input'), { target: { value: 'click: Go\nexpect: Done' } })
    await waitFor(() => expect((screen.getByTestId('bv-run') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('bv-run'))
    expect(start).toHaveBeenCalledWith('s1', 'http://127.0.0.1:3000/', [
      { kind: 'click', target: 'Go' },
      { kind: 'expect', text: 'Done' },
    ])
  })
})

describe('BrowserVerifyEvidence', () => {
  it('shows the outcome, steps, console errors, blocked requests and screenshot', () => {
    render(
      <BrowserVerifyEvidence
        report={{
          id: 'x',
          url: 'http://localhost:5173/',
          origin: 'http://localhost:5173',
          outcome: 'failed',
          reason: 'The page tried to navigate to https://evil.example/, outside the allowed origin.',
          steps: [{ index: 0, label: 'Open http://localhost:5173/', status: 'failed', detail: null, duration_ms: 5 }],
          screenshots: [{ step: null, png_base64: 'iVBORw0KGgo=' }],
          console_errors: [{ kind: 'error', text: 'boom' }],
          blocked_requests: [{ url: 'https://evil.example/', resource_type: 'Document', navigation: true }],
          document_status: 302,
          final_url: null,
          browser: 'Chromium',
          started_at: new Date(0).toISOString(),
          duration_ms: 12,
          profile_removed: true,
        }}
      />
    )
    expect(screen.getByTestId('bv-evidence').getAttribute('data-outcome')).toBe('failed')
    expect(screen.getByTestId('bv-steps').textContent).toContain('Open http://localhost:5173/')
    expect(screen.getByTestId('bv-console').textContent).toContain('boom')
    expect(screen.getByTestId('bv-blocked').textContent).toContain('https://evil.example/')
    expect(screen.getByTestId('bv-screenshot').getAttribute('src')).toContain('data:image/png;base64,')
  })
})
