import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CaBundleStatus } from '@/containers/CaBundleStatus'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const i18n = (await import('@/i18n/setup')).default
  return {
    useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => i18n.t(k, o) }),
  }
})

describe('CaBundleStatus (AH-190)', () => {
  it('says the platform roots alone are trusted when nothing is configured', () => {
    render(<CaBundleStatus status={{ state: 'none' }} />)
    expect(screen.getByTestId('ca-bundle-status-none').textContent).toMatch(/platform/i)
  })

  it('shows how many certificates are trusted and their fingerprints', () => {
    const sha = 'a'.repeat(64)
    render(<CaBundleStatus status={{ state: 'in_use', path: 'C:/certs/corp.pem', certificates: 1, sha256: [sha] }} />)
    const shown = screen.getByTestId('ca-bundle-status-in-use').textContent ?? ''
    expect(shown).toContain('1')
    expect(shown).toContain(sha)
  })

  it('says a broken bundle trusts nothing, with the kind and the reason', () => {
    render(
      <CaBundleStatus
        status={{ state: 'broken', kind: 'malformed', path: 'C:/certs/junk.pem', message: 'certificate 1 in junk.pem is not a certificate' }}
      />
    )
    const shown = screen.getByTestId('ca-bundle-status-broken').textContent ?? ''
    expect(shown).toContain('malformed')
    expect(shown).toMatch(/nothing/i)
    expect(shown).toContain('is not a certificate')
  })
})
