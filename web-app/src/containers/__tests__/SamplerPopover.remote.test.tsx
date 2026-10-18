import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

  // Web search lives behind this button, so it opens even here.
  it('opens to the web search row when the chat offers web search', async () => {
    const onChange = vi.fn()
    render(
      <SamplerPopover
        providerId="anthropic"
        webSearch={{ enabled: false, onChange }}
      />
    )
    const btn = screen.getByRole('button', { name: 'common:sampler.label' })
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    const toggle = await screen.findByRole('switch', { name: 'common:web_search' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(true))
    expect(
      screen.getByText('common:sampler.notSupported|Anthropic')
    ).toBeInTheDocument()
  })
})
