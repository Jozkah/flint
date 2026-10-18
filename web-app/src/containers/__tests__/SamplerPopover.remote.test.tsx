import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SamplerPopover } from '../SamplerPopover'

vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: (sel: (s: unknown) => unknown) =>
    sel({ currentAssistant: undefined, updateAssistant: vi.fn(), loading: false }),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: unknown) => unknown) =>
    sel({ providers: [{ provider: 'anthropic', displayName: 'Anthropic' }] }),
}))
vi.mock('@/lib/providerCaps', () => ({
  isPredefinedRemoteProvider: () => true,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, string>) =>
      v ? `${k}|${Object.values(v).join('|')}` : k,
  }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('SamplerPopover for a remote provider', () => {
  it('shows a disabled control that says why', () => {
    render(<SamplerPopover providerId="anthropic" />)
    const btn = screen.getByRole('button', { name: 'common:sampler.label' })
    expect(btn).toBeDisabled()
    expect(
      screen.getByText('common:sampler.notSupported|Anthropic')
    ).toBeInTheDocument()
  })
})
