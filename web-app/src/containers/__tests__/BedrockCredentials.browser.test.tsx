import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/platform/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/utils')>()),
  isPlatformTauri: () => false,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
const status = vi.fn()
vi.mock('@/lib/bedrock', () => ({
  getBedrockCredentialStatus: () => status(),
  setBedrockCredential: vi.fn(),
}))

import { BedrockCredentials } from '@/containers/BedrockCredentials'

describe('Bedrock credentials in a plain browser', () => {
  it('explains they are desktop-only and asks nothing of the server', () => {
    render(<BedrockCredentials />)
    expect(screen.getByTestId('bedrock-desktop-only').textContent).toContain(
      'permissions:desktopOnly'
    )
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(status).not.toHaveBeenCalled()
  })
})
