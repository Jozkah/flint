import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { HooksViewerCard } from '../HooksViewerCard'
import * as trust from '@/lib/folderTrust'
import * as hooks from '@/lib/hooksReport'
import en from '@/locales/en/permissions.json'

const t = (key: string) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let v: any = en
  for (const p of key.replace('permissions:', '').split('.')) v = v?.[p]
  return String(v ?? key)
}
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t }),
}))
vi.mock('@/lib/folderTrust', () => ({ listTrustedFolders: vi.fn() }))
vi.mock('@/lib/hooksReport', () => ({ hooksReport: vi.fn() }))

describe('HooksViewerCard', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
  })

  it('lists each trusted folder hooks file with its hooks', async () => {
    vi.mocked(trust.listTrustedFolders).mockResolvedValue(['C:/app'])
    vi.mocked(hooks.hooksReport).mockResolvedValue({
      source: 'C:/app/.jan/agent/hooks.toml',
      exists: true,
      trusted: true,
      error: null,
      declared: 1,
      hooks: [
        {
          event: 'pre-tool',
          command: 'npm run lint',
          onFailure: 'block',
          timeoutSecs: 30,
          tools: ['write'],
          stdinJson: false,
          if: 'bash(git push)',
          jsonOutput: false,
        },
      ],
    })
    render(<HooksViewerCard />)
    await waitFor(() => screen.getByTestId('hooks-viewer-file'))
    expect(screen.getByText('C:/app/.jan/agent/hooks.toml')).toBeTruthy()
    expect(screen.getByText(/npm run lint/)).toBeTruthy()
  })

  it('says so when no trusted folder has hooks', async () => {
    vi.mocked(trust.listTrustedFolders).mockResolvedValue([])
    render(<HooksViewerCard />)
    await waitFor(() => screen.getByTestId('hooks-viewer-empty'))
  })
})
