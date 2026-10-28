import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { VoiceSetupDialog } from '../VoiceSetupDialog'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}))
vi.mock('@/lib/voice/installVoiceModel', () => ({
  installVoiceModel: vi.fn(),
}))

describe('VoiceSetupDialog', () => {
  it('renders its copy from translation keys, with sizes as parameters', () => {
    render(<VoiceSetupDialog open onOpenChange={() => {}} />)
    expect(screen.getByText('sweep:voice.setup.title')).toBeInTheDocument()
    expect(screen.getByText('sweep:voice.setup.unloads')).toBeInTheDocument()
    expect(
      screen.getByText(/sweep:voice\.setup\.memory:.*3\.5 GB/)
    ).toBeInTheDocument()
  })
})
